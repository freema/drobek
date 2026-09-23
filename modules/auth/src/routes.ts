/**
 * `/__drobek/v1/auth/…` on every app host:
 *
 *   POST send-code { email }        → e-mail a 6-digit code (allowlist first)
 *   POST verify    { email, code }  → session cookie + { user }
 *   GET  me                         → { user | null } (+ rolls the session)
 *   POST logout                     → { ok: true } (+ clears the cookie)
 *
 * The code and its limits are the dashboard login's own machinery from
 * @drobek/auth (atomic INCR guess counter, PHY-76 #1; the OTP guard layers),
 * scoped to `eu:<app_id>` so one app's end users never share codes, counters
 * or pauses with the dashboard or another app. Sessions are the core
 * end-user sessions of @drobek/modules (`drobek:eu:<app_id>:<token>`, epoch
 * revocation), so every other module sees the signed-in user as
 * `ctx.principal` without importing this one.
 */
import {
  CODE_TTL_S,
  consumeEmailLoginCode,
  createEmailLoginCode,
  guardOtpRequest,
  logOtpSent,
  maskEmail,
  otpGuardLimitsFromEnv,
  releaseOtpCooldown,
  type OtpGuardLimits,
} from '@drobek/auth';
import { getRedis } from '@drobek/core';
import {
  END_USER_SESSION_TTL_SEC,
  ModuleError,
  createEndUserSession,
  destroyEndUserSession,
  endUserCookieHeader,
  endUserCookiesSecure,
  loadEndUserSession,
  readEndUserToken,
  renewEndUserSession,
  respond,
  z,
  type EndUserRedis,
  type ModuleContext,
  type ModuleRouter,
} from '@drobek/modules';
import { decideSignIn, type AccessResult, type AuthConfig } from './config.js';
import { currentUser } from './current.js';
import type { AuthUserRow } from './schema.js';
import {
  appDisplayName,
  countUsers,
  findUserByEmail,
  isWorkspaceEditor,
  recordSignIn,
  setUserRole,
} from './users.js';

type Ctx = ModuleContext<AuthConfig>;

export interface PublicUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

const ATTEMPT_WINDOW_MS = 15 * 60_000;
const MAX_NAME = 60;

const emailField = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'must be an e-mail address' }));
const sendCodeBody = z.strictObject({ email: emailField });
const verifyBody = z.strictObject({
  email: emailField,
  code: z.string().trim().regex(/^\d{6}$/, 'must be the 6-digit code from the e-mail'),
});

function redis(): EndUserRedis {
  return getRedis() as unknown as EndUserRedis;
}

/** The OTP scope of one app's end users (keys `drobek:otp:eu:<app_id>:…`). */
export function otpScope(appId: string): string {
  return `eu:${appId}`;
}

function publicUser(row: Pick<AuthUserRow, 'id' | 'email' | 'role'>): PublicUser {
  return { id: row.id, email: row.email, role: row.role };
}

/** A name that is safe on one line of plain text: no control characters, capped. */
export function safeName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return clean.length > MAX_NAME ? `${clean.slice(0, MAX_NAME - 1)}…` : clean || 'this app';
}

/** The Host header, if it is a plain host[:port] (it is already a resolved app host). */
function safeHost(host: string | null): string | null {
  const h = (host ?? '').trim().toLowerCase();
  return /^[a-z0-9.-]+(?::\d{1,5})?$/.test(h) ? h : null;
}

export function signInEmail(input: { appName: string; host: string | null; code: string }): { subject: string; text: string } {
  const name = safeName(input.appName);
  const where = input.host ? ` on ${input.host}` : '';
  return {
    subject: `${input.code} is your sign-in code for ${name}`,
    text: [
      `Your sign-in code for "${name}":`,
      '',
      input.code,
      '',
      `Enter it${where} within ${Math.round(CODE_TTL_S / 60)} minutes. It works once.`,
      'If you did not try to sign in, ignore this e-mail: nobody can sign in without the code.',
    ].join('\n'),
  };
}

function notAllowed(): ModuleError {
  return new ModuleError('email_not_allowed', 'This e-mail address may not sign in to this app.', { status: 403 });
}

async function guardLimits(ctx: Ctx): Promise<OtpGuardLimits> {
  const l = await ctx.limits();
  return {
    ipShortLimit: l.AUTH_CODES_PER_IP_15MIN,
    ipDailyLimit: l.AUTH_CODES_PER_IP_DAY,
    emailHourlyLimit: l.AUTH_CODES_PER_EMAIL_HOUR,
    emailCooldownMs: otpGuardLimitsFromEnv().emailCooldownMs,
    globalHourlyMax: l.AUTH_CODES_PER_APP_HOUR,
  };
}

/** Who `email` is to this app right now (allowlist, workspace editors, disabled, end-user cap). */
async function checkSignIn(
  ctx: Ctx,
  email: string
): Promise<{ access: Extract<AccessResult, { allowed: true }>; existing: AuthUserRow | null }> {
  const workspaceEditor = await isWorkspaceEditor(ctx.db, ctx.app.workspaceId, email);
  const access = decideSignIn({ config: ctx.config, email, workspaceEditor });
  const existing = await findUserByEmail(ctx.db, ctx.app.id, email);
  if (!access.allowed || existing?.disabledAt) {
    ctx.log.info('auth: sign-in refused', {
      app_id: ctx.app.id,
      reason: access.allowed ? 'disabled' : 'not_allowed',
      email: maskEmail(email),
    });
    throw notAllowed();
  }
  if (!existing) {
    const max = (await ctx.limits()).END_USERS_MAX_PER_APP;
    if ((await countUsers(ctx.db, ctx.app.id)) >= max) {
      throw new ModuleError('limit_exceeded', `This app already has its maximum of ${max} users.`, {
        details: { limit: 'END_USERS_MAX_PER_APP', value: max },
      });
    }
  }
  return { access, existing };
}

function sessionCookie(token: string): Record<string, string> {
  return { 'Set-Cookie': endUserCookieHeader(token, { maxAgeSec: END_USER_SESSION_TTL_SEC }, endUserCookiesSecure()) };
}

function clearedCookie(): Record<string, string> {
  return { 'Set-Cookie': endUserCookieHeader('', { maxAgeSec: 0, clear: true }, endUserCookiesSecure()) };
}

export function registerRoutes(r: ModuleRouter<AuthConfig>): void {
  const attempts = { bucket: 'attempts', max: 'AUTH_ATTEMPTS_PER_IP_15MIN', windowMs: ATTEMPT_WINDOW_MS, per: 'ip' as const };

  r.post('/send-code', { rule: 'public', body: sendCodeBody, rateLimit: attempts, maxBodyBytes: 1024 }, async (req, ctx) => {
    const email = req.body.email;
    await checkSignIn(ctx, email);

    const scope = otpScope(ctx.app.id);
    const ip = req.clientIp ?? undefined;
    const sent = { sent: true as const, email, expires_in: CODE_TTL_S };
    const decision = await guardOtpRequest({ ip, email, limits: await guardLimits(ctx), scope });
    if (!decision.ok) {
      // A code went out a moment ago (cooldown) or this address had its
      // hourly share: answer exactly like a send and send nothing new.
      if (decision.kind === 'redirect_verify') return sent;
      if (decision.status === 429) {
        throw new ModuleError('rate_limited', 'Too many sign-in codes from here. Try again later.', {
          headers: { 'Retry-After': decision.reason === 'ip_short' ? '900' : '3600' },
        });
      }
      throw new ModuleError('unavailable', 'Sign-in e-mails are paused for a while. Try again later.', {
        headers: { 'Retry-After': '900' },
      });
    }

    const code = await createEmailLoginCode(email, ip, scope);
    const appName = await appDisplayName(ctx.db, ctx.app.id, ctx.app.slug);
    const message = signInEmail({ appName, host: safeHost(req.header('host')), code });
    try {
      const out = await ctx.email.send({ to: { signInAddress: email }, ...message });
      if (out.sent !== 1) throw new Error('the address was not accepted');
    } catch (err) {
      await releaseOtpCooldown(email, scope);
      ctx.log.error('auth: sign-in e-mail failed', { app_id: ctx.app.id, email: maskEmail(email), error: String((err as Error)?.message ?? err) });
      throw new ModuleError('unavailable', 'The sign-in e-mail could not be sent. Try again in a moment.');
    }
    logOtpSent({ ip, email, scope });
    return sent;
  });

  r.post('/verify', { rule: 'public', body: verifyBody, rateLimit: attempts, maxBodyBytes: 1024 }, async (req, ctx) => {
    const { email, code } = req.body;
    const consumed = await consumeEmailLoginCode(email, code, otpScope(ctx.app.id));
    if (!consumed.ok) {
      if (consumed.reason === 'too_many_attempts') {
        throw new ModuleError('too_many_attempts', 'Too many wrong codes. Request a new code.', { status: 429 });
      }
      throw new ModuleError('invalid_code', 'That code is not valid or has expired. Check it, or request a new code.', { status: 400 });
    }
    // The allowlist may have changed since the code was sent — decide again.
    const { access, existing } = await checkSignIn(ctx, email);
    const row = await recordSignIn(ctx.db, ctx.app.id, email, access.role);
    const token = await createEndUserSession(redis(), ctx.app.id, publicUser(row));
    await ctx.audit('sign_in', { user_id: row.id, role: row.role, new_user: !existing });
    return respond(200, { user: publicUser(row) }, sessionCookie(token));
  });

  r.get('/me', { rule: 'public' }, async (req, ctx) => {
    const token = readEndUserToken(req.header('cookie'), endUserCookiesSecure());
    if (!token) return { user: null };
    const store = redis();
    const session = await loadEndUserSession(store, ctx.app.id, token);
    if (!session) return respond(200, { user: null }, clearedCookie());

    // The same decision core makes for every module request (current.ts):
    // removed from the allowlist, disabled or deleted → signed out; the role
    // follows the config (and is written back to the row here).
    const now = await currentUser(ctx.db, ctx.app, ctx.config, session.id);
    if (!now) {
      await destroyEndUserSession(store, ctx.app.id, token);
      return respond(200, { user: null }, clearedCookie());
    }
    const user: PublicUser = now.user;
    if (now.row.role !== user.role) await setUserRole(ctx.db, ctx.app.id, user.id, user.role);
    await renewEndUserSession(store, ctx.app.id, token, { ...session, ...user });
    return respond(200, { user }, sessionCookie(token));
  });

  r.post('/logout', { rule: 'public' }, async (req, ctx) => {
    const token = readEndUserToken(req.header('cookie'), endUserCookiesSecure());
    if (token) await destroyEndUserSession(redis(), ctx.app.id, token);
    return respond(200, { ok: true }, clearedCookie());
  });
}
