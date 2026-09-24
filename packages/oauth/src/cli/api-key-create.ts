/**
 * `task api-key:create` (M0-04) — create a personal API key for a user and
 * print it ONCE. Dashboard management (list / revoke / last used) is the
 * M2-04 /me/api-keys page.
 *
 *   node packages/oauth/dist/cli/api-key-create.js \
 *     --email you@example.com --name laptop --scopes read,write
 *
 * `--create-user` creates the user when the e-mail has never signed in: an
 * operator's service account for an agent or a smoke test (`task e2e:smoke`)
 * that needs no mailbox. Its personal workspace is created by the first MCP
 * `create_app`, as for any user. Only someone with shell access to the server
 * (DATABASE_URL) can run this.
 *
 * Talks to DATABASE_URL (the task runs it inside the dev container). Only the
 * SHA-256 of the key is stored; the key itself goes to stdout and nowhere else.
 */
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { closeDb, dbErrorForLog, getDb, users } from '@drobek/db';
import { ensureUserByEmail } from '@drobek/auth';
import { createApiKey } from '../api-keys.server.js';
import { isKnownScope, SCOPES, type Scope } from '../scopes.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string', default: 'cli' },
      scopes: { type: 'string', default: 'read,write' },
      'create-user': { type: 'boolean', default: false },
    },
  });
  const email = values.email?.trim().toLowerCase();
  if (!email) {
    console.error(
      'usage: api-key-create --email <user email> [--name <label>] [--scopes read,write,publish] [--create-user]'
    );
    return 2;
  }
  const requested = (values.scopes ?? '').split(/[,\s]+/).filter(Boolean);
  const unknown = requested.filter((s) => !isKnownScope(s));
  if (unknown.length > 0 || requested.length === 0) {
    console.error(`scopes must be a non-empty subset of: ${SCOPES.join(', ')}`);
    return 2;
  }

  let [user] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user && values['create-user']) {
    user = { id: await ensureUserByEmail(email) };
    console.error(`created user ${email}`);
  }
  if (!user) {
    console.error(`no user with email ${email} — sign in once first, or pass --create-user`);
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
