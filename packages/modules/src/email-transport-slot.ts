/**
 * The `email.transport` slot: an e-mail provider (SES, Postmark, a company
 * relay, …) as a module. The built-in `email` module hosts the slot (a slot
 * belongs to a module named by its prefix); core selects the contribution
 * whose id EMAIL_TRANSPORT names and installs it into @drobek/email, which
 * then carries every message of the server through it: the dashboard's
 * sign-in codes and invites as well as the modules' `ctx.email.send`.
 *
 *   export default defineModule({
 *     name: 'postmark', …,
 *     requires: ['email'],
 *     contributes: {
 *       'email.transport': defineEmailTransport({
 *         id: 'postmark', label: 'Postmark', secrets: ['POSTMARK_TOKEN'],
 *         async send(msg, { secrets, signal }) { … },
 *       }),
 *     },
 *   });
 *
 * `smtp` and `resend` stay built in and cannot be replaced. The transport's
 * secrets are operator env vars only (read at start, handed to `send` in
 * `ctx.secrets`); the rate limits above the transport stay as they are. The
 * built-in `email` declares the slot `operatorOnly`: a transport module needs
 * no skill.
 */
import {
  BUILTIN_EMAIL_TRANSPORTS,
  EMAIL_TRANSPORT_API_VERSION,
  EMAIL_TRANSPORT_ID_RE,
  emailTransportId,
  emailTransportKind,
  installEmailTransport,
  missingTransportSecrets,
  type ModuleEmailTransport,
} from '@drobek/email';
import type { Logger } from '@drobek/core';
import { z, type ZodType } from 'zod';
import type { AnyModule } from './contract.js';
import { ModuleLoadError } from './errors.js';

export const EMAIL_TRANSPORT_SLOT = 'email.transport';

/** Type a transport contribution (identity at run time). */
export function defineEmailTransport(transport: ModuleEmailTransport): ModuleEmailTransport {
  return transport;
}

const SECRET_ENV = /^[A-Z][A-Z0-9_]{1,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** The `email.transport` slot's schema (unknown keys kept). */
export const emailTransportSchema = z
  .looseObject({
    apiVersion: z
      .custom<typeof EMAIL_TRANSPORT_API_VERSION>((v) => v === EMAIL_TRANSPORT_API_VERSION, {
        error: (iss) => `${JSON.stringify(iss.input) ?? typeof iss.input} is not an e-mail transport API this server implements (${EMAIL_TRANSPORT_API_VERSION})`,
      })
      .optional(),
    id: z
      .string()
      .regex(EMAIL_TRANSPORT_ID_RE, 'id must be 2–16 lowercase letters and digits, starting with a letter')
      .refine((id) => !(BUILTIN_EMAIL_TRANSPORTS as readonly string[]).includes(id), 'id "smtp" and "resend" are the built-in transports — pick another'),
    label: z.string().min(1).max(40).refine((l) => !CONTROL.test(l) && l.trim() === l, 'label must be one trimmed line'),
    secrets: z
      .array(z.string().regex(SECRET_ENV, 'a secret is the name of an UPPER_SNAKE env var'))
      .max(20)
      .refine((names) => new Set(names).size === names.length, 'secrets name an env var twice')
      .optional(),
    send: z.custom<ModuleEmailTransport['send']>((v) => typeof v === 'function', 'send must be a function'),
  }) as unknown as ZodType<ModuleEmailTransport>;

/** Every active module's `email.transport` contribution with its module (already checked against the slot at load). */
function contributedTransports(modules: AnyModule[]): { module: string; transport: ModuleEmailTransport }[] {
  return modules.flatMap((m) => {
    const value = m.contributes?.[EMAIL_TRANSPORT_SLOT];
    return value === undefined ? [] : [{ module: m.name, transport: value as ModuleEmailTransport }];
  });
}

/**
 * The module transport EMAIL_TRANSPORT selects, or null for `smtp` / `resend`.
 * Refuses the start (ModuleLoadError) when no active module contributes that
 * id or the server env lacks one of its secrets. The env value itself is
 * never echoed — the message lists the ids that are available.
 */
export function selectEmailTransport(modules: AnyModule[], env: NodeJS.ProcessEnv = process.env): { module: string; transport: ModuleEmailTransport } | null {
  if (emailTransportKind(env) !== 'module') return null;
  const id = emailTransportId(env);
  const all = contributedTransports(modules);
  const hit = all.find((c) => c.transport.id === id);
  if (!hit) {
    const ids = all.map((c) => c.transport.id);
    const hosted = modules.some((m) => m.name === 'email');
    throw new ModuleLoadError(
      `EMAIL_TRANSPORT names no e-mail transport of the active modules (built in: ${BUILTIN_EMAIL_TRANSPORTS.join(', ')}; from modules: ${ids.length > 0 ? ids.join(', ') : 'none'}) — add the module that contributes it to DROBEK_MODULES${hosted ? '' : ' together with "email" (it hosts the email.transport slot)'}, or set EMAIL_TRANSPORT=smtp`
    );
  }
  const missing = missingTransportSecrets(hit.transport, env);
  if (missing.length > 0) {
    throw new ModuleLoadError(
      `the e-mail transport "${hit.transport.id}" (module "${hit.module}") needs ${missing.join(', ')} in the server env — set ${missing.length > 1 ? 'them' : 'it'}, or switch EMAIL_TRANSPORT back to smtp`
    );
  }
  return hit;
}

/** Select the module transport (see `selectEmailTransport`) and install it into @drobek/email — or uninstall for smtp / resend. */
export function installModuleEmailTransport(modules: AnyModule[], env: NodeJS.ProcessEnv = process.env, log?: Logger): ModuleEmailTransport | null {
  const hit = selectEmailTransport(modules, env);
  try {
    installEmailTransport(hit?.transport ?? null, env);
  } catch (err) {
    throw new ModuleLoadError((err as Error).message);
  }
  if (hit) log?.info('e-mail goes out through a module transport', { transport: hit.transport.id, module: hit.module });
  return hit?.transport ?? null;
}
