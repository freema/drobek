/**
 * `task api-key:create` (M0-04) — create a personal API key for an EXISTING
 * user and print it ONCE. Dashboard management (list / revoke / last used)
 * is the M2-04 /me/api-keys page; this CLI exists for local testing.
 *
 *   node packages/oauth/dist/cli/api-key-create.js \
 *     --email you@example.com --name laptop --scopes read,write
 *
 * Talks to DATABASE_URL (the task runs it inside the dev container). Only the
 * SHA-256 of the key is stored; the key itself goes to stdout and nowhere else.
 */
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { closeDb, dbErrorForLog, getDb, users } from '@drobek/db';
import { createApiKey } from '../api-keys.server.js';
import { isKnownScope, SCOPES, type Scope } from '../scopes.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string', default: 'cli' },
      scopes: { type: 'string', default: 'read,write' },
    },
  });
  const email = values.email?.trim().toLowerCase();
  if (!email) {
    console.error('usage: api-key-create --email <user email> [--name <label>] [--scopes read,write,publish]');
    return 2;
  }
  const requested = (values.scopes ?? '').split(/[,\s]+/).filter(Boolean);
  const unknown = requested.filter((s) => !isKnownScope(s));
  if (unknown.length > 0 || requested.length === 0) {
    console.error(`scopes must be a non-empty subset of: ${SCOPES.join(', ')}`);
    return 2;
  }

  const [user] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    console.error(`no user with email ${email} — sign in once first`);
    return 1;
  }

  const created = await createApiKey({
    userId: user.id,
    name: values.name ?? 'cli',
    scopes: requested as Scope[],
  });
  console.error(`API key ${created.id} for ${email} (scopes: ${created.scopes}). It is shown only once:`);
  console.log(created.key);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error(dbErrorForLog(err));
    await closeDb();
    process.exit(1);
  });
