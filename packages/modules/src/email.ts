/**
 * `ctx.email.send()` recipients (M1-01, M1-02, M1-04) — shared by the runtime
 * and the test context so both resolve exactly the same way. A module never
 * names an arbitrary address: it points at owner-confirmed config, at the
 * signed-in end user, at the app's owners (verified drobek accounts), or
 * (auth only) at the address being signed in with.
 */
import type { EmailKind, EmailMessage, EmailRecipient, Principal } from './contract.js';
import { ModuleError } from './errors.js';

/** Replace anything address-like in a free text (error messages) — logs never carry addresses. */
export function redactAddresses(text: string): string {
  return text.replace(/[^\s@<>,;"'()[\]\\]+@[^\s@<>,;"'()[\]\\]+/g, '[address]');
}

export const EMAIL_RE = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+\.[^\s@<>,;"()[\]\\]+$/;
const MAX_SUBJECT = 200;
/** Longest message text a module may send (characters). */
export const MAX_EMAIL_TEXT = 20_000;

function valueAtPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** One header line: control characters (CR/LF/TAB, C0, DEL, U+2028/9) → a space, trimmed, capped. */
export function sanitizeSubject(subject: unknown): string {
  return String(subject ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_SUBJECT);
}

/** The message text, capped at MAX_EMAIL_TEXT characters (plain text; the layout escapes it). */
export function capEmailText(text: unknown): string {
  const t = String(text ?? '');
  return t.length > MAX_EMAIL_TEXT ? `${t.slice(0, MAX_EMAIL_TEXT - 1)}…` : t;
}

function isValidAddress(a: string): boolean {
  return a.length <= 254 && EMAIL_RE.test(a);
}

/** The recipient references of a message (one or several). */
export function recipientRefs(to: EmailMessage['to']): EmailRecipient[] {
  const refs = Array.isArray(to) ? to : [to];
  if (refs.length === 0) throw new Error('ctx.email.send: `to` names no recipient');
  if (refs.length > 1 && refs.some((r) => r && typeof r === 'object' && 'signInAddress' in r)) {
    throw new Error('ctx.email.send: { signInAddress } must be the only recipient of a message');
  }
  return refs;
}

/** A sign-in code, or a notification. */
export function emailKind(to: EmailMessage['to']): EmailKind {
  return recipientRefs(to).some((r) => 'signInAddress' in r) ? 'sign_in' : 'notification';
}

/**
 * `{ signInAddress }` reaches an address nobody confirmed and spends the
 * server's sign-in budget, so only the sign-in provider may use it (NSO-327):
 * the one active module that owns end-user sessions (`endUsers` — the `auth`
 * module). Any other module gets `forbidden` (403) and nothing is sent.
 * `signInProvider` = that module's name, or null when none is active.
 */
export function assertSignInSender(kind: EmailKind, module: string, signInProvider: string | null): void {
  if (kind !== 'sign_in' || module === signInProvider) return;
  throw new ModuleError(
    'forbidden',
    `Module "${module}" may not send sign-in codes: { signInAddress } is reserved for the module that signs end users in${signInProvider ? ` ("${signInProvider}")` : ''}.`,
    { details: { reason: 'sign_in_address_not_allowed', module } }
  );
}

export interface RecipientSources {
  principal: Principal;
  /** The sending module's effective config for this app. */
  config: unknown;
  /** The app's owners' addresses (only called when a message asks for them). */
  owners?: () => Promise<string[]>;
}

/**
 * The addresses a message goes to ([] = nobody), lowercased and de-duplicated.
 * Throws `unauthorized` for `{ principal }` without a signed-in user.
 */
export async function resolveRecipients(to: EmailMessage['to'], src: RecipientSources): Promise<string[]> {
  const out: string[] = [];
  const add = (a: unknown) => {
    if (typeof a !== 'string') return;
    const v = a.trim().toLowerCase();
    if (isValidAddress(v) && !out.includes(v)) out.push(v);
  };
  for (const ref of recipientRefs(to)) {
    if ('principal' in ref) {
      if (src.principal.kind !== 'user') throw new ModuleError('unauthorized', 'Sign in to this app first.');
      add(src.principal.email);
    } else if ('signInAddress' in ref) {
      add(ref.signInAddress);
    } else if ('appOwners' in ref) {
      for (const a of (await src.owners?.()) ?? []) add(a);
    } else if ('config' in ref) {
      const v = valueAtPath(src.config, String(ref.config));
      for (const a of Array.isArray(v) ? v : [v]) add(a);
    }
  }
  return out;
}
