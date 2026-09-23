/**
 * `ctx.email.send()` recipients (M1-01, M1-02) — shared by the runtime and
 * the test context so both resolve exactly the same way. A module never names
 * an arbitrary address: it points at owner-confirmed config, at the signed-in
 * end user, or (auth only) at the address being signed in with.
 */
import type { EmailMessage, Principal } from './contract.js';
import { ModuleError } from './errors.js';

export const EMAIL_RE = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+\.[^\s@<>,;"()[\]\\]+$/;
const MAX_SUBJECT = 200;

function valueAtPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
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

/** The addresses a message goes to ([] = nobody). Throws `unauthorized` for `{ principal }` without a signed-in user. */
export function resolveRecipients(to: EmailMessage['to'], principal: Principal, config: unknown): string[] {
  if ('principal' in to) {
    if (principal.kind !== 'user') throw new ModuleError('unauthorized', 'Sign in to this app first.');
    return [principal.email];
  }
  if ('signInAddress' in to) {
    const a = String(to.signInAddress ?? '').trim();
    return a.length <= 254 && EMAIL_RE.test(a) ? [a] : [];
  }
  const v = valueAtPath(config, to.config);
  return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && EMAIL_RE.test(x));
}
