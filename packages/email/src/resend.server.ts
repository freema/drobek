/**
 * The Resend transport: one `POST https://api.resend.com/emails` per message
 * over the global `fetch` — no vendor SDK. Same message as the SMTP transport
 * (EMAIL_FROM's address under an optional display name, one recipient,
 * subject, text, html, Reply-To).
 *
 * The API key only ever goes into the Authorization header: it is never
 * logged and never part of an error message, and Resend's response body is
 * not echoed either (it can quote the recipient) — an error carries the HTTP
 * status and Resend's error `name` (a fixed identifier) only.
 */
import type { OutgoingEmail } from './send.server.js';
import { resendApiKey } from './transport.server.js';

export const RESEND_API_URL = 'https://api.resend.com/emails';
/** How long one send may take before it is aborted. */
export const RESEND_TIMEOUT_MS = 10_000;

/** Why a send failed — the callers map every code onto their existing "could not be sent" answer. */
export type EmailSendErrorCode = 'rate_limited' | 'unauthorized' | 'rejected' | 'unavailable' | 'timeout';

export class EmailSendError extends Error {
  readonly code: EmailSendErrorCode;
  /** HTTP status of the provider's answer (absent for network errors and timeouts). */
  readonly status?: number;
  /** Seconds the provider asked to wait (429 Retry-After). */
  readonly retryAfterSec?: number;
  /** Worth another try later (429, 5xx, network, timeout). */
  readonly retryable: boolean;

  constructor(code: EmailSendErrorCode, message: string, opts: { status?: number; retryAfterSec?: number } = {}) {
    super(message);
    this.name = 'EmailSendError';
    this.code = code;
    this.status = opts.status;
    this.retryAfterSec = opts.retryAfterSec;
    this.retryable = code === 'rate_limited' || code === 'unavailable' || code === 'timeout';
  }
}

/** The sender as `{ name, address }` (EMAIL_FROM's address, the display name already one plain line). */
export type Sender = { name: string; address: string };

/** The JSON body of `POST /emails`: `from` is `"Name" <address>` (the name has no quotes left) or the bare address. */
export function resendPayload(mail: OutgoingEmail, from: Sender): Record<string, unknown> {
  return {
    from: from.name ? `"${from.name}" <${from.address}>` : from.address,
    to: [mail.to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
  };
}

const ERROR_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Resend's error `name` (e.g. `rate_limit_exceeded`) when the body has a plain one — never the free-text message. */
async function errorName(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { name?: unknown } | null;
    return typeof body?.name === 'string' && ERROR_NAME.test(body.name) ? body.name : null;
  } catch {
    return null;
  }
}

function retryAfter(res: Response): number | undefined {
  const n = Number(res.headers.get('retry-after'));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

/** An HTTP failure of Resend → EmailSendError (429 → rate_limited, 401/403 → unauthorized, other 4xx → rejected, 5xx → unavailable). */
async function resendHttpError(res: Response): Promise<EmailSendError> {
  const name = await errorName(res);
  const detail = `HTTP ${res.status}${name ? ` ${name}` : ''}`;
  if (res.status === 429) {
    return new EmailSendError('rate_limited', `Resend refused the message: rate limited (${detail})`, {
      status: res.status,
      retryAfterSec: retryAfter(res),
    });
  }
  if (res.status === 401 || res.status === 403) {
    return new EmailSendError('unauthorized', `Resend refused the API key or the sender domain (${detail}); check RESEND_API_KEY and EMAIL_FROM`, {
      status: res.status,
    });
  }
  if (res.status >= 400 && res.status < 500) {
    return new EmailSendError('rejected', `Resend rejected the message (${detail})`, { status: res.status });
  }
  return new EmailSendError('unavailable', `Resend is unavailable (${detail})`, { status: res.status });
}

export interface ResendSendOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Deliver `mail` from `from` through Resend; resolves with Resend's message id, throws EmailSendError. */
export async function sendViaResend(
  mail: OutgoingEmail,
  from: Sender,
  env: NodeJS.ProcessEnv = process.env,
  opts: ResendSendOptions = {}
): Promise<string | null> {
  const key = resendApiKey(env);
  if (!key) throw new EmailSendError('unauthorized', 'EMAIL_TRANSPORT=resend needs RESEND_API_KEY');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? RESEND_TIMEOUT_MS;
  let res: Response;
  try {
    res = await doFetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'User-Agent': 'drobek',
      },
      body: JSON.stringify(resendPayload(mail, from)),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new EmailSendError('timeout', `Resend did not answer within ${timeoutMs} ms`);
    }
    // The fetch error's text is not carried over; the kind is enough.
    throw new EmailSendError('unavailable', 'Resend could not be reached (network error)');
  }
  if (!res.ok) throw await resendHttpError(res);
  try {
    const body = (await res.json()) as { id?: unknown } | null;
    return typeof body?.id === 'string' ? body.id : null;
  } catch {
    return null;
  }
}
