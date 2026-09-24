import { describe, expect, it } from 'vitest';
import { serializeError } from './logger.server.js';

const EMAIL = 'alice.private@corp.example';

/** The drizzle-orm ≥ 0.44 shape of a failed insert (postgres.js cause). */
function failedQuery(): Error {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
    name: 'PostgresError',
    severity: 'ERROR',
    code: '23505',
    detail: `Key (email)=(${EMAIL}) already exists.`,
    constraint_name: 'users_email_unique',
    table_name: 'users',
  });
  return Object.assign(new Error(`Failed query: insert into "users" ("email") values ($1)\nparams: ${EMAIL}`, { cause }), {
    name: 'DrizzleQueryError',
    query: 'insert into "users" ("email") values ($1)',
    params: [EMAIL],
  });
}

describe('serializeError (NSO-333)', () => {
  it('a failed query keeps code, constraint and table — never the bound e-mail', () => {
    const out = serializeError(failedQuery());
    expect(out.message).toBe('db error 23505 (constraint users_email_unique, table users)');
    expect(JSON.stringify(out)).not.toContain(EMAIL);
    expect(out.stack).toMatch(/^db error 23505 .*\n\s+at /);
  });

  it('any other error keeps its message and stack', () => {
    const err = new Error('token exchange failed');
    expect(serializeError(err)).toEqual({ message: 'token exchange failed', stack: err.stack });
    expect(serializeError('boom')).toEqual({ message: 'boom' });
  });
});
