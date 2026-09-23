/**
 * DB-backed (PGlite) tests of the audited account mutations (M2-04): the
 * audit rows land in the actor's personal workspace, carry no secret, show up
 * under the actor filter and in the Activity CSV.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@drobek/db/schema';
import { setDbForTests, users } from '@drobek/db';
import { listActivity } from '@drobek/audit';
import {
  createClient,
  createDbOAuthStore,
  issueAccessAndRefresh,
  rotateRefreshToken,
  validateApiKey,
} from '@drobek/oauth';
import { ensurePersonalWorkspace } from '@drobek/tenancy';
import {
  AccountError,
  createAccountApiKey,
  revokeAccountApiKey,
  revokeAccountConnection,
} from './account.server.js';
import { activityCsvLines } from './activity-csv.server.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url));

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db as never);
});
afterAll(async () => pg.close());

async function signedIn(email: string) {
  const [u] = await db.insert(users).values({ email }).returning();
  return { id: u.id, email };
}

describe('audited account mutations (M2-04)', () => {
  it('create + revoke an API key are audited in the personal workspace, without the key', async () => {
    const user = await signedIn('keys-audit@example.test');
    const created = await createAccountApiKey(user, { name: 'CI', scopes: ['read', 'write'] });
    expect(created.key).toMatch(/^drk_/);
    expect(await validateApiKey(created.key)).not.toBeNull();

    await revokeAccountApiKey(user, created.id);
    expect(await validateApiKey(created.key)).toBeNull();
    await expect(revokeAccountApiKey(user, created.id)).rejects.toBeInstanceOf(AccountError);

    const ws = await ensurePersonalWorkspace(user.id, user.email);
    const { rows } = await listActivity({ workspaceId: ws.id, actorKind: 'user' });
    const mine = rows.filter((r) => r.target === created.id);
    expect(mine.map((r) => r.action).sort()).toEqual(['api_key.create', 'api_key.revoke']);
    for (const r of mine) {
      expect(r.subjectType).toBe('api_key');
      expect(r.actorUserId).toBe(user.id);
      expect(r.meta).toEqual({ name: 'CI', scopes: ['read', 'write'] });
    }
    expect(JSON.stringify(rows)).not.toContain(created.key);

    // The actor filter separates user rows from end-user rows.
    expect((await listActivity({ workspaceId: ws.id, actorKind: 'end_user' })).rows).toEqual([]);

    // The Activity CSV carries the new actions.
    const csv = activityCsvLines(
      rows.map((r) => ({
        createdAt: r.createdAt.toISOString(),
        action: r.action,
        actorKind: r.actorKind,
        actor: r.actorEmail ?? '',
        subjectType: r.subjectType,
        subject: r.target,
      }))
    ).join('\n');
    expect(csv).toContain(`,api_key.create,user,${user.email},api_key,${created.id}`);
    expect(csv).toContain(`,api_key.revoke,user,${user.email},api_key,${created.id}`);
  });

  it("another user's key cannot be revoked (404, nothing audited)", async () => {
    const owner = await signedIn('owner-audit@example.test');
    const other = await signedIn('other-audit@example.test');
    const key = await createAccountApiKey(owner, { name: 'mine', scopes: ['read'] });
    await expect(revokeAccountApiKey(other, key.id)).rejects.toMatchObject({ status: 404 });
    expect(await validateApiKey(key.key)).not.toBeNull();
  });

  it('revoking a connection is audited as oauth_client.revoke and kills the refresh token', async () => {
    const user = await signedIn('conn-audit@example.test');
    const client = await createClient({ clientName: 'Claude Code', redirectUris: ['http://127.0.0.1:1/cb'] });
    const store = createDbOAuthStore(db as never);
    const grant = await issueAccessAndRefresh(
      { userId: user.id, oauthClientId: client.id, scope: 'read', audience: 'http://x/mcp' },
      store
    );

    await revokeAccountConnection(user, client.id);
    expect(await rotateRefreshToken(grant.refreshToken, store)).toMatchObject({
      ok: false,
      error: 'invalid_grant',
    });
    await expect(revokeAccountConnection(user, client.id)).rejects.toMatchObject({ status: 404 });

    const ws = await ensurePersonalWorkspace(user.id, user.email);
    const { rows } = await listActivity({ workspaceId: ws.id, action: 'oauth_client.revoke' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subjectType: 'oauth_client',
      target: client.clientId,
      actorKind: 'user',
      meta: { client_name: 'Claude Code', source: 'dcr', access_tokens: 1, refresh_tokens: 1 },
    });
  });
});
