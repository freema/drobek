/**
 * Changing the sign-in e-mail, on PGlite with the core migrations and an
 * in-memory Redis: the code goes to the new address and changes only that
 * account to only that address, an address another account uses gets a
 * notice instead (same answer on the page), every other session ends while
 * keys and the Google link stay, the previous address is told, the audit row
 * records what SUPERADMIN_EMAIL made of it, and the sends obey the sign-in
 * code limits under their own scope.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiKeys, auditLog, setDbForTests, users } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { TenancyFakeRedis } from './fake-redis.js';

let fake: TenancyFakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return {
    ...actual,
    getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis>,
  };
});

type Mail =
  | { kind: 'code'; email: string; code: string }
  | { kind: 'in_use'; email: string }
  | { kind: 'changed'; email: string; newEmail: string; contact: string | null };
const mails: Mail[] = [];
let failNotice = false;
vi.mock('./email/email-change.server.js', () => ({
  sendEmailChangeCodeEmail: async (a: { email: string; code: string }) => {
    mails.push({ kind: 'code', ...a });
  },
  sendEmailInUseEmail: async (a: { email: string }) => {
    mails.push({ kind: 'in_use', ...a });
  },
  sendEmailChangedEmail: async (a: { email: string; newEmail: string; contact: string | null }) => {
    if (failNotice) throw new Error('smtp down');
    mails.push({ kind: 'changed', ...a });
  },
}));

import { createEmailLoginCode, createUserSession, getSessionUser } from '@drobek/auth';
import { EMAIL_CHANGE_OTP_SCOPE, confirmEmailChange, emailChangeCodeScope, requestEmailChange } from './email-change.server.js';
import { ensurePersonalWorkspace } from './personal-workspace.server.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: join(ROOT, 'packages/db/drizzle/migrations'),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db);
});

afterAll(async () => {
  setDbForTests(null);
  await pg.close();
});

beforeEach(() => {
  fake = new TenancyFakeRedis();
  mails.length = 0;
  failNotice = false;
  vi.stubEnv('SUPERADMIN_EMAIL', '');
  vi.stubEnv('OPERATOR_EMAIL', '');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

let n = 0;

async function user(tag: string, extra: { googleSub?: string } = {}): Promise<{ id: string; email: string }> {
  n += 1;
  const email = `${tag}-${n}@example.test`;
  const [u] = await db.insert(users).values({ email, ...extra }).returning({ id: users.id });
  return { id: u!.id, email };
}

function address(tag: string): string {
  n += 1;
  return `${tag}-${n}@example.test`;
}

async function emailOf(userId: string): Promise<string | undefined> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return row?.email;
}

async function sessionOf(token: string) {
  return getSessionUser(new Request('http://localhost/me', { headers: { Cookie: `drobek_session=${token}` } }));
}

function tokenOf(setCookie: string): string {
  const m = /^drobek_session=([0-9a-f]{96});/.exec(setCookie);
  if (!m) throw new Error(`no session cookie in ${setCookie}`);
  return m[1]!;
}

function codeFor(email: string): string {
  const mail = mails.find((m): m is Extract<Mail, { kind: 'code' }> => m.kind === 'code' && m.email === email);
  if (!mail) throw new Error(`no code mail to ${email}`);
  return mail.code;
}

function otherThan(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

async function changeAudit(userId: string) {
  return db
    .select({ workspaceId: auditLog.workspaceId, actorKind: auditLog.actorKind, actorUserId: auditLog.actorUserId, meta: auditLog.meta })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'account.email_change'), eq(auditLog.target, userId)))
    .orderBy(auditLog.createdAt, auditLog.id);
}

describe('requestEmailChange + confirmEmailChange', () => {
  it('e-mails a code to the new address; the code changes the address once, other sessions end, keys and the Google link stay', async () => {
    const sub = `google-sub-${n}`;
    const owner = await user('owner', { googleSub: sub });
    const personal = await ensurePersonalWorkspace(owner.id, owner.email);
    await db.insert(apiKeys).values({ userId: owner.id, name: 'ci', keyHash: `kh-${n}`, scopes: 'read' });
    const laptop = await createUserSession(owner.id, owner.email);
    const phone = await createUserSession(owner.id, owner.email);
    const bystander = await user('bystander');
    const theirs = await createUserSession(bystander.id, bystander.email);
    const next = address('next');

    expect(await requestEmailChange({ userId: owner.id, currentEmail: owner.email, newEmail: `  ${next.toUpperCase()} `, ip: undefined })).toEqual({
      ok: true,
      email: next,
      sent: true,
    });
    expect(mails.map((m) => [m.kind, m.email])).toEqual([['code', next]]);
    const code = codeFor(next);
    expect([...fake.store.keys()].some((k) => k.startsWith(`drobek:otp:${emailChangeCodeScope(owner.id)}:code:`))).toBe(true);

    // A wrong code changes nothing.
    const wrong = await confirmEmailChange({ userId: owner.id, newEmail: next, code: otherThan(code), ip: undefined });
    expect(wrong).toMatchObject({ ok: false, status: 400 });
    expect(await emailOf(owner.id)).toBe(owner.email);
    expect(await sessionOf(laptop.token)).toMatchObject({ id: owner.id });

    const done = await confirmEmailChange({ userId: owner.id, newEmail: next, code: ` ${code} `, ip: undefined });
    if (!done.ok) throw new Error(done.message);
    expect(done).toMatchObject({ email: next, previousEmail: owner.email, sessionsEnded: 2 });

    const [row] = await db.select({ email: users.email, googleSub: users.googleSub }).from(users).where(eq(users.id, owner.id));
    expect(row).toEqual({ email: next, googleSub: sub });
    expect(await db.select({ revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.userId, owner.id))).toEqual([{ revokedAt: null }]);

    expect(await sessionOf(laptop.token)).toBeNull();
    expect(await sessionOf(phone.token)).toBeNull();
    expect(await sessionOf(tokenOf(done.setCookie))).toEqual({ id: owner.id, email: next });
    expect(await sessionOf(theirs.token)).toMatchObject({ id: bystander.id });

    expect(await changeAudit(owner.id)).toEqual([{ workspaceId: personal.id, actorKind: 'user', actorUserId: owner.id, meta: null }]);
    expect(mails.at(-1)).toEqual({ kind: 'changed', email: owner.email, newEmail: next, contact: null });

    // Single use.
    expect(await confirmEmailChange({ userId: owner.id, newEmail: next, code, ip: undefined })).toMatchObject({ ok: false, status: 400 });
  });

  it('an address another account signs in with gets a notice instead of a code, and the answer looks the same', async () => {
    const mover = await user('mover');
    const holder = await user('holder');

    const answer = await requestEmailChange({ userId: mover.id, currentEmail: mover.email, newEmail: holder.email.toUpperCase(), ip: undefined });
    expect(answer).toEqual({ ok: true, email: holder.email, sent: true });
    expect(mails).toEqual([{ kind: 'in_use', email: holder.email }]);
    expect([...fake.store.keys()].some((k) => k.startsWith(`drobek:otp:${emailChangeCodeScope(mover.id)}:code:`))).toBe(false);

    for (const code of ['000000', '123456']) {
      expect(await confirmEmailChange({ userId: mover.id, newEmail: holder.email, code, ip: undefined })).toMatchObject({ ok: false, status: 400 });
    }
    expect(await emailOf(mover.id)).toBe(mover.email);
    expect(await changeAudit(mover.id)).toEqual([]);
  });

  it('a code is bound to its account and to its address; a sign-in code never changes an address', async () => {
    const a = await user('bound-a');
    const b = await user('bound-b');
    const target = address('target');
    await requestEmailChange({ userId: a.id, currentEmail: a.email, newEmail: target, ip: undefined });
    const code = codeFor(target);

    expect(await confirmEmailChange({ userId: b.id, newEmail: target, code, ip: undefined })).toMatchObject({ ok: false });
    expect(await confirmEmailChange({ userId: a.id, newEmail: address('elsewhere'), code, ip: undefined })).toMatchObject({ ok: false });
    const login = await createEmailLoginCode(target, undefined);
    if (login !== code) {
      expect(await confirmEmailChange({ userId: a.id, newEmail: target, code: login, ip: undefined })).toMatchObject({ ok: false });
    }
    expect(await emailOf(b.id)).toBe(b.email);

    expect(await confirmEmailChange({ userId: a.id, newEmail: target, code, ip: undefined })).toMatchObject({ ok: true, email: target });
    expect(await emailOf(a.id)).toBe(target);
  });

  it('refuses an invalid address and the current one, and sends within the sign-in code limits under its own scope', async () => {
    const u = await user('limits');
    expect(await requestEmailChange({ userId: u.id, currentEmail: u.email, newEmail: 'not-an-address', ip: undefined })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await requestEmailChange({ userId: u.id, currentEmail: u.email, newEmail: ` ${u.email.toUpperCase()}`, ip: undefined })).toMatchObject({
      ok: false,
      status: 400,
      message: expect.stringContaining('already sign in with this address'),
    });
    expect(mails).toEqual([]);

    const next = address('cooldown');
    expect(await requestEmailChange({ userId: u.id, currentEmail: u.email, newEmail: next, ip: undefined })).toEqual({ ok: true, email: next, sent: true });
    // Within the per-address cooldown nothing new goes out; the first code stays valid.
    expect(await requestEmailChange({ userId: u.id, currentEmail: u.email, newEmail: next, ip: undefined })).toEqual({ ok: true, email: next, sent: false });
    expect(mails).toHaveLength(1);

    const hash = createHash('sha256').update(next).digest('hex');
    const keys = [...fake.store.keys()];
    expect(keys).toContain(`drobek:rl:${EMAIL_CHANGE_OTP_SCOPE}:otp-email-1h:${hash}`);
    expect(keys.some((k) => k.startsWith('drobek:rl:otp-'))).toBe(false);

    // Per client IP, like the sign-in codes.
    vi.stubEnv('OTP_IP_SHORT_LIMIT', '1');
    expect(await requestEmailChange({ userId: u.id, currentEmail: u.email, newEmail: address('ip-a'), ip: '203.0.113.9' })).toMatchObject({ ok: true, sent: true });
    expect(await requestEmailChange({ userId: u.id, currentEmail: u.email, newEmail: address('ip-b'), ip: '203.0.113.9' })).toMatchObject({
      ok: false,
      status: 429,
    });

    // The operator's kill switch stops these codes too.
    vi.stubEnv('OTP_LOGIN_DISABLED', '1');
    expect(await requestEmailChange({ userId: u.id, currentEmail: u.email, newEmail: address('paused'), ip: undefined })).toMatchObject({
      ok: false,
      status: 503,
    });
  });

  it('stops when another account took the address meanwhile, and nothing changes', async () => {
    const u = await user('race');
    const session = await createUserSession(u.id, u.email);
    const next = address('contested');
    await requestEmailChange({ userId: u.id, currentEmail: u.email, newEmail: next, ip: undefined });
    await db.insert(users).values({ email: next });

    expect(await confirmEmailChange({ userId: u.id, newEmail: next, code: codeFor(next), ip: undefined })).toMatchObject({ ok: false, status: 409 });
    expect(await emailOf(u.id)).toBe(u.email);
    expect(await sessionOf(session.token)).toMatchObject({ id: u.id });
    expect(await changeAudit(u.id)).toEqual([]);
    expect(mails.filter((m) => m.kind === 'changed')).toEqual([]);
  });

  it('super-admin rights follow the address: the audit row says when they came or went', async () => {
    const boss = address('boss');
    vi.stubEnv('SUPERADMIN_EMAIL', `${boss},other@example.test`);
    const u = await user('promote');
    await requestEmailChange({ userId: u.id, currentEmail: u.email, newEmail: boss, ip: undefined });
    expect(await confirmEmailChange({ userId: u.id, newEmail: boss, code: codeFor(boss), ip: undefined })).toMatchObject({ ok: true });
    // The operator contact (the first super-admin) is the new address here, and is still named to the old one.
    expect(mails.at(-1)).toEqual({ kind: 'changed', email: u.email, newEmail: boss, contact: boss });

    const plain = address('plain');
    await requestEmailChange({ userId: u.id, currentEmail: boss, newEmail: plain, ip: undefined });
    expect(await confirmEmailChange({ userId: u.id, newEmail: plain, code: codeFor(plain), ip: undefined })).toMatchObject({ ok: true, email: plain });
    // The notice never names the recipient itself as the operator to write to.
    expect(mails.at(-1)).toEqual({ kind: 'changed', email: boss, newEmail: plain, contact: null });

    expect((await changeAudit(u.id)).map((a) => a.meta)).toEqual([{ super_admin: 'gained' }, { super_admin: 'lost' }]);
  });

  it('a notice the previous address cannot get does not undo the change', async () => {
    const u = await user('notice');
    const next = address('notice-next');
    await requestEmailChange({ userId: u.id, currentEmail: u.email, newEmail: next, ip: undefined });
    failNotice = true;
    expect(await confirmEmailChange({ userId: u.id, newEmail: next, code: codeFor(next), ip: undefined })).toMatchObject({ ok: true, email: next });
    expect(await emailOf(u.id)).toBe(next);
    expect(await changeAudit(u.id)).toHaveLength(1);
  });
});
