/**
 * Rotating DROBEK_MASTER_KEY over the stored secrets (upstream + module
 * secrets): the counts per key, the start verdict, `task selfhost:rekey`
 * (re-wrap, idempotent, FORGET_UNKNOWN) and that no key or value ever shows
 * up in a message.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { apps, moduleSecrets, upstreamSecrets, upstreams, workspaces } from '@drobek/db';
import { decryptSecret, encryptSecret, kekFromEnv } from '@drobek/proxy';
import {
  previousMasterKeyConfigError,
  rekeyReport,
  rekeySecrets,
  secretKeyCounts,
  secretKeysStartCheck,
  storedSecretKeysCheck,
} from './secret-keys.server.js';
import { getModuleSecret, setModuleSecret } from './secrets.server.js';
import { freshDb, type TestDb } from './test/db.js';

const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);
const KEY_C = 'c3'.repeat(32);
const envA = { DROBEK_MASTER_KEY: KEY_A } as NodeJS.ProcessEnv;
const envB = { DROBEK_MASTER_KEY: KEY_B } as NodeJS.ProcessEnv;
/** Rotated from A to B; A still reads. */
const rotating = { DROBEK_MASTER_KEY: KEY_B, DROBEK_MASTER_KEY_PREVIOUS: KEY_A } as NodeJS.ProcessEnv;
const production = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, NODE_ENV: 'production' });

const UPSTREAM_SECRET = 'upstream-token-value-0123456789';
const MODULE_SECRET = 'module-signature-value-0123456789';

let db: TestDb;
let close: () => Promise<void>;
let workspaceId: string;
let appId: string;

beforeAll(async () => {
  const fresh = await freshDb();
  db = fresh.db;
  close = () => fresh.pg.close();
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  const [a] = await db.insert(apps).values({ workspaceId: w.id, slug: 'crm' }).returning();
  workspaceId = w.id;
  appId = a.id;
});

afterAll(async () => close());

beforeEach(async () => {
  await db.delete(moduleSecrets);
  await db.delete(upstreams);
});

async function upstreamWithSecret(name: string, env: NodeJS.ProcessEnv): Promise<string> {
  const [u] = await db
    .insert(upstreams)
    .values({ workspaceId, name, baseUrl: 'https://api.example.com', allowedMethods: ['GET'], allowedPathPrefixes: ['/'], authType: 'bearer' })
    .returning();
  await db.insert(upstreamSecrets).values({ upstreamId: u.id, ...encryptSecret(UPSTREAM_SECRET, env) });
  return u.id;
}

/** Two upstream secrets + two module secrets written under key A (before the rotation). */
async function seedUnderA(): Promise<void> {
  await upstreamWithSecret('billing', envA);
  await upstreamWithSecret('crm', envA);
  await setModuleSecret({ appId, module: 'hello', name: 'HELLO_SIGNATURE', value: MODULE_SECRET, env: envA });
  await setModuleSecret({ appId, module: 'auth', name: 'AUTH_GITHUB_CLIENT_SECRET', value: MODULE_SECRET, env: envA });
}

function expectNoKeyOrValue(text: string): void {
  for (const s of [KEY_A, KEY_B, KEY_C, UPSTREAM_SECRET, MODULE_SECRET]) expect(text).not.toContain(s);
}

describe('the start check', () => {
  it('refuses a production start when envelopes are under a key the server does not have', async () => {
    await seedUnderA();
    expect(await secretKeyCounts(envB)).toEqual([
      { table: 'upstream_secrets', current: 0, previous: 0, unknown: 2 },
      { table: 'module_secrets', current: 0, previous: 0, unknown: 2 },
    ]);
    const verdict = await storedSecretKeysCheck(production(envB));
    expect(verdict?.level).toBe('fatal');
    expect(verdict?.message).toContain('drobek refuses to start: 4 stored secrets are encrypted under a key this server does not have');
    expect(verdict?.message).toContain('(upstream_secrets 2, module_secrets 2)');
    expect(verdict?.message).toContain('set the key used before as DROBEK_MASTER_KEY_PREVIOUS');
    expect(verdict?.message).toContain('task selfhost:rekey FORGET_UNKNOWN=1');
    expectNoKeyOrValue(verdict!.message);
  });

  it('outside production the same finding is a warning (a development database may hold test rows)', async () => {
    await seedUnderA();
    const verdict = await storedSecretKeysCheck({ ...envB, NODE_ENV: 'development' });
    expect(verdict?.level).toBe('warn');
    expect(verdict?.message).toContain('they cannot be decrypted');
  });

  it('starts with DROBEK_MASTER_KEY_PREVIOUS and asks for task selfhost:rekey', async () => {
    await seedUnderA();
    await setModuleSecret({ appId, module: 'hello', name: 'HELLO_NEW', value: MODULE_SECRET, env: rotating });
    expect(await secretKeyCounts(rotating)).toEqual([
      { table: 'upstream_secrets', current: 0, previous: 2, unknown: 0 },
      { table: 'module_secrets', current: 1, previous: 2, unknown: 0 },
    ]);
    expect(await storedSecretKeysCheck(production(rotating))).toEqual({
      level: 'warn',
      message:
        '4 stored secrets are still encrypted under DROBEK_MASTER_KEY_PREVIOUS (upstream_secrets 2, module_secrets 2) — run `task selfhost:rekey`, then remove DROBEK_MASTER_KEY_PREVIOUS.',
    });
    // A secret of the previous key reads; one written now uses the current key.
    expect(await getModuleSecret(appId, 'hello', 'HELLO_SIGNATURE', rotating)).toBe(MODULE_SECRET);
    expect(await getModuleSecret(appId, 'hello', 'HELLO_NEW', envB)).toBe(MODULE_SECRET);
  });

  it('says nothing on a database without secrets, and that an unneeded previous key can go', () => {
    const empty = [
      { table: 'upstream_secrets' as const, current: 0, previous: 0, unknown: 0 },
      { table: 'module_secrets' as const, current: 3, previous: 0, unknown: 0 },
    ];
    expect(secretKeysStartCheck(empty, production(envB))).toBeNull();
    expect(secretKeysStartCheck(empty, production(rotating))).toEqual({
      level: 'info',
      message: 'every stored secret is encrypted under DROBEK_MASTER_KEY — DROBEK_MASTER_KEY_PREVIOUS is no longer needed: remove it and restart drobek.',
    });
  });
});

describe('rekeySecrets (task selfhost:rekey)', () => {
  it('re-wraps every envelope of the previous key, then DROBEK_MASTER_KEY alone reads them; a second run changes nothing', async () => {
    await seedUnderA();
    const before = await db.select().from(moduleSecrets).where(eq(moduleSecrets.name, 'HELLO_SIGNATURE'));

    const first = await rekeySecrets({ env: rotating });
    expect(first.map(({ table, current, rewrapped, unknown, forgotten, unreadable }) => ({ table, current, rewrapped, unknown, forgotten, unreadable }))).toEqual([
      { table: 'upstream_secrets', current: 0, rewrapped: 2, unknown: 0, forgotten: 0, unreadable: 0 },
      { table: 'module_secrets', current: 0, rewrapped: 2, unknown: 0, forgotten: 0, unreadable: 0 },
    ]);
    const report = rekeyReport(first, rotating);
    expect(report.ok).toBe(true);
    expect(report.lines).toEqual([
      'upstream_secrets: 2 re-wrapped, 0 already under DROBEK_MASTER_KEY, 0 under an unknown key',
      'module_secrets: 2 re-wrapped, 0 already under DROBEK_MASTER_KEY, 0 under an unknown key',
      'every stored secret is encrypted under DROBEK_MASTER_KEY — remove DROBEK_MASTER_KEY_PREVIOUS and restart drobek.',
    ]);

    // Only the wrap changed: same ciphertext, the current kek_id, the set time kept.
    const [after] = await db.select().from(moduleSecrets).where(eq(moduleSecrets.name, 'HELLO_SIGNATURE'));
    expect(after.ciphertext).toBe(before[0].ciphertext);
    expect(after.wrappedDek).not.toBe(before[0].wrappedDek);
    expect(after.kekId).toBe(kekFromEnv(envB).id);
    expect(after.updatedAt).toEqual(before[0].updatedAt);

    // The previous key can go.
    expect(await getModuleSecret(appId, 'hello', 'HELLO_SIGNATURE', envB)).toBe(MODULE_SECRET);
    expect(await getModuleSecret(appId, 'auth', 'AUTH_GITHUB_CLIENT_SECRET', envB)).toBe(MODULE_SECRET);
    for (const row of await db.select().from(upstreamSecrets)) expect(decryptSecret(row, envB)).toBe(UPSTREAM_SECRET);
    expect(await storedSecretKeysCheck(production(envB))).toBeNull();

    const second = await rekeySecrets({ env: rotating });
    expect(second.map((c) => [c.table, c.rewrapped, c.current])).toEqual([
      ['upstream_secrets', 0, 2],
      ['module_secrets', 0, 2],
    ]);
    const again = rekeyReport(second, envB);
    expect(again.ok).toBe(true);
    expect(again.lines.at(-1)).toBe('every stored secret is encrypted under DROBEK_MASTER_KEY.');
  });

  it('leaves envelopes of an unknown key, names them, and deletes them only with forgetUnknown', async () => {
    await seedUnderA();
    await upstreamWithSecret('legacy', { DROBEK_MASTER_KEY: KEY_C });
    await setModuleSecret({ appId, module: 'hello', name: 'HELLO_LOST', value: MODULE_SECRET, env: { DROBEK_MASTER_KEY: KEY_C } });

    const kept = await rekeySecrets({ env: rotating });
    expect(kept.map((c) => [c.table, c.rewrapped, c.unknown, c.forgotten, c.affected])).toEqual([
      ['upstream_secrets', 2, 1, 0, ['acme/legacy']],
      ['module_secrets', 2, 1, 0, ['acme/crm hello.HELLO_LOST']],
    ]);
    const report = rekeyReport(kept, rotating);
    expect(report.ok).toBe(false);
    expect(report.lines).toContain('upstream_secrets: 2 re-wrapped, 0 already under DROBEK_MASTER_KEY, 1 under an unknown key');
    expect(report.lines).toContain('  - acme/legacy');
    expect(report.lines.at(-1)).toContain('2 stored secrets are encrypted under a key this server does not have');
    expect(report.lines.at(-1)).toContain('task selfhost:rekey FORGET_UNKNOWN=1');
    expect(await db.select().from(upstreamSecrets)).toHaveLength(3);

    // Without the previous key, the start would refuse them.
    expect((await storedSecretKeysCheck(production(envB)))?.level).toBe('fatal');

    const forgot = await rekeySecrets({ env: envB, forgetUnknown: true });
    expect(forgot.map((c) => [c.table, c.rewrapped, c.current, c.unknown, c.forgotten])).toEqual([
      ['upstream_secrets', 0, 2, 1, 1],
      ['module_secrets', 0, 2, 1, 1],
    ]);
    const forgotReport = rekeyReport(forgot, envB);
    expect(forgotReport.ok).toBe(true);
    expect(forgotReport.lines).toContain('module_secrets: 0 re-wrapped, 2 already under DROBEK_MASTER_KEY, 1 under an unknown key (1 deleted)');
    expect(forgotReport.lines).toContain('2 secrets under an unknown key deleted — their owners set them again in the dashboard.');
    expect(await db.select().from(upstreamSecrets)).toHaveLength(2);
    expect(await getModuleSecret(appId, 'hello', 'HELLO_LOST', envB)).toBeNull();
    expect(await storedSecretKeysCheck(production(envB))).toBeNull();
  });

  it('leaves a damaged envelope of the previous key as it is and reports it', async () => {
    const id = await upstreamWithSecret('broken', envA);
    const [row] = await db.select().from(upstreamSecrets).where(eq(upstreamSecrets.upstreamId, id));
    await db.update(upstreamSecrets).set({ wrappedDek: row.wrappedDek.replace(/.$/, row.wrappedDek.endsWith('A') ? 'B' : 'A') }).where(eq(upstreamSecrets.upstreamId, id));

    const counts = await rekeySecrets({ env: rotating, forgetUnknown: true });
    expect(counts[0]).toMatchObject({ table: 'upstream_secrets', rewrapped: 0, unreadable: 1, forgotten: 0, affected: ['acme/broken'] });
    const report = rekeyReport(counts, rotating);
    expect(report.ok).toBe(false);
    expect(report.lines.at(-1)).toBe(
      '1 stored secret under DROBEK_MASTER_KEY_PREVIOUS could not be opened (damaged) and stayed unchanged — its owner needs to set it again.'
    );
    const [still] = await db.select().from(upstreamSecrets).where(eq(upstreamSecrets.upstreamId, id));
    expect(still.kekId).toBe(kekFromEnv(envA).id);
  });

  it('never puts a key or a secret value into its report', async () => {
    await seedUnderA();
    await upstreamWithSecret('legacy', { DROBEK_MASTER_KEY: KEY_C });
    const report = rekeyReport(await rekeySecrets({ env: rotating }), rotating);
    expectNoKeyOrValue(report.lines.join('\n'));
  });
});

describe('previousMasterKeyConfigError', () => {
  it('accepts an unset or a valid previous key and refuses a malformed one by name only', () => {
    expect(previousMasterKeyConfigError(envB)).toBeNull();
    expect(previousMasterKeyConfigError(rotating)).toBeNull();
    expect(previousMasterKeyConfigError({ ...envB, DROBEK_MASTER_KEY_PREVIOUS: 'a passphrase of more than thirty-two characters' })).toBeNull();
    const problem = previousMasterKeyConfigError({ ...envB, DROBEK_MASTER_KEY_PREVIOUS: 'too-short-x9' });
    expect(problem).toContain('drobek refuses to start: DROBEK_MASTER_KEY_PREVIOUS is not a valid key.');
    expect(problem).not.toContain('too-short-x9');
  });
});
