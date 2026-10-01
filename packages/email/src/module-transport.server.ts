/**
 * An e-mail transport a platform module contributes to the `email.transport`
 * slot (hosted by the `email` module), chosen with EMAIL_TRANSPORT=<its id>.
 * SMTP and Resend stay in this package: the dashboard's sign-in codes and
 * invites never depend on an installed module.
 *
 * The module runtime installs the selected transport at start, process-wide
 * (on globalThis, so the dev server's Vite-loaded copy of this package sees
 * it too), with the values of the env vars it declares in `secrets`. A
 * transport is a server-level thing: its secrets come from the operator's
 * env only, never from an app, MCP or the dashboard. Every send is cut off
 * after EMAIL_TRANSPORT_TIMEOUT_MS; whatever it throws reaches the caller as
 * an EmailSendError whose message has every secret value redacted.
 */
import { EMAIL_SEND_ERROR_CODES, EmailSendError, type EmailSendErrorCode, type Sender } from './resend.server.js';
import { emailTransportTimeoutError, emailTransportTimeoutMs } from './transport.server.js';
import type { OutgoingEmail } from './send.server.js';

/** The transport API this server implements (a contribution may declare it as `apiVersion`). */
export const EMAIL_TRANSPORT_API_VERSION = 1;

/** One message, as the built-in transports send it: EMAIL_FROM's address under a one-line display name, one recipient. */
export interface EmailTransportMessage {
  from: Sender;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}

export interface EmailTransportContext {
  /** The values of the env vars the transport declared in `secrets` (all set: the server refuses to start otherwise). Never log them. */
  secrets: Readonly<Record<string, string>>;
  /** Aborted when the send runs past EMAIL_TRANSPORT_TIMEOUT_MS: pass it to `fetch`. */
  signal: AbortSignal;
}

/**
 * A module's e-mail transport (the `email.transport` slot). `send` is called
 * unbound; it resolves once the provider accepted the message and throws
 * otherwise — an EmailSendError with one of its codes keeps the code, any
 * other error becomes `unavailable`.
 */
export interface ModuleEmailTransport {
  apiVersion?: typeof EMAIL_TRANSPORT_API_VERSION;
  /** `EMAIL_TRANSPORT_ID_RE`, not `smtp` or `resend`; unique within the slot. */
  id: string;
  /** The provider's name for logs and docs (1–40 characters). */
  label: string;
  /** The operator env vars the transport needs (UPPER_SNAKE), e.g. `['POSTMARK_TOKEN']`. */
  secrets?: string[];
  send(message: EmailTransportMessage, ctx: EmailTransportContext): Promise<void>;
}

interface Installed {
  transport: ModuleEmailTransport;
  secrets: Readonly<Record<string, string>>;
  timeoutMs: number;
}

const KEY = Symbol.for('drobek.email.moduleTransport');
type Holder = { [KEY]?: Installed };

/** The env vars of `transport.secrets` that are unset or blank in `env` (names only). */
export function missingTransportSecrets(transport: Pick<ModuleEmailTransport, 'secrets'>, env: NodeJS.ProcessEnv = process.env): string[] {
  return (transport.secrets ?? []).filter((name) => !env[name]?.trim());
}

/**
 * Make `transport` the operator's transport for every send whose
 * EMAIL_TRANSPORT names its id (null uninstalls). Reads its secrets and the
 * timeout from `env` now; throws when one is missing or invalid.
 */
export function installEmailTransport(transport: ModuleEmailTransport | null, env: NodeJS.ProcessEnv = process.env): void {
  const g = globalThis as Holder;
  if (!transport) {
    delete g[KEY];
    return;
  }
  const missing = missingTransportSecrets(transport, env);
  if (missing.length > 0) throw new Error(`the e-mail transport "${transport.id}" needs ${missing.join(', ')} in the server env`);
  const timeoutMs = emailTransportTimeoutMs(env);
  if (timeoutMs === null) throw new Error(emailTransportTimeoutError(env)!);
  const secrets = Object.freeze(Object.fromEntries((transport.secrets ?? []).map((name) => [name, env[name]!.trim()])));
  g[KEY] = { transport, secrets, timeoutMs };
}

/** The id of the installed module transport, or null. */
export function installedEmailTransportId(): string | null {
  return (globalThis as Holder)[KEY]?.transport.id ?? null;
}

const REDACTED = '[redacted]';

/** `text` with every secret value replaced. */
export function redactSecrets(text: string, secrets: Readonly<Record<string, string>>): string {
  let out = text;
  for (const value of Object.values(secrets).sort((a, b) => b.length - a.length)) {
    if (value) out = out.split(value).join(REDACTED);
  }
  return out;
}

function isSendErrorLike(err: unknown): err is { code: EmailSendErrorCode; message: string; status?: number; retryAfterSec?: number } {
  const e = err as { name?: unknown; code?: unknown } | null;
  return e?.name === 'EmailSendError' && (EMAIL_SEND_ERROR_CODES as readonly unknown[]).includes(e.code);
}

const MAX_DETAIL = 300;

/** What the transport threw → an EmailSendError naming the transport, secrets redacted. */
function mapTransportError(err: unknown, installed: Installed): EmailSendError {
  const { transport, secrets } = installed;
  const who = `e-mail transport "${transport.id}"`;
  const detail = (msg: unknown) => redactSecrets(String(msg ?? ''), secrets).replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
  if (isSendErrorLike(err)) {
    return new EmailSendError(err.code, `${who}: ${detail(err.message)}`, { status: err.status, retryAfterSec: err.retryAfterSec });
  }
  const name = (err as { name?: unknown } | null)?.name;
  const label = typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Error';
  const message = detail(err instanceof Error ? err.message : err);
  return new EmailSendError('unavailable', `${who} failed (${label}${message ? `: ${message}` : ''})`);
}

/** Deliver through the installed module transport `id`; throws EmailSendError. */
export async function sendViaModuleTransport(mail: OutgoingEmail, from: Sender, id: string): Promise<void> {
  const installed = (globalThis as Holder)[KEY];
  if (!installed || installed.transport.id !== id) {
    throw new EmailSendError('unavailable', 'EMAIL_TRANSPORT names a module transport that is not installed (the server installs it from DROBEK_MODULES at start)');
  }
  const { transport, secrets, timeoutMs } = installed;
  const message: EmailTransportMessage = {
    from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
  };
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EmailSendError('timeout', `e-mail transport "${transport.id}" did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(() => transport.send(message, { secrets, signal: controller.signal })), timeout]);
  } catch (err) {
    if (err instanceof EmailSendError && err.code === 'timeout' && controller.signal.aborted) throw err;
    throw mapTransportError(err, installed);
  } finally {
    clearTimeout(timer);
  }
}

/** @internal test helper */
export function resetEmailTransportForTests(): void {
  delete (globalThis as Holder)[KEY];
}
