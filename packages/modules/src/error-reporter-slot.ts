/**
 * The `errors.reporter` slot: where the server's errors go besides stdout
 * (Sentry, an incident webhook, a log service, …) as a module. Core hosts the
 * slot (no module named `errors` exists: the name is reserved), so a reporter
 * module needs nothing else in DROBEK_MODULES. Core selects the contribution
 * whose id ERROR_REPORTER names and installs it into @drobek/core, whose
 * `reportError` the server's central error points call.
 *
 *   export default defineModule({
 *     name: 'sentry', …,
 *     contributes: {
 *       'errors.reporter': defineErrorReporter({
 *         apiVersion: 1, id: 'sentry', label: 'Sentry', secrets: ['SENTRY_DSN'],
 *         async report(event, { secrets, signal }) { … },
 *       }),
 *     },
 *   });
 *
 * The reporter's secrets are operator env vars only (read at start, handed to
 * `report` in `ctx.secrets`, redacted from every event and log line).
 */
import {
  ERROR_REPORTER_API_VERSION,
  ERROR_REPORTER_ID_RE,
  errorReporterId,
  installErrorReporter,
  missingReporterSecrets,
  type ErrorReporter,
  type Logger,
} from '@drobek/core';
import { z, type ZodType } from 'zod';
import type { AnyModule, ModuleSlot } from './contract.js';
import { ModuleLoadError } from './errors.js';

export const ERROR_REPORTER_SLOT = 'errors.reporter';

/** Type a reporter contribution (identity at run time). */
export function defineErrorReporter(reporter: ErrorReporter): ErrorReporter {
  return reporter;
}

const SECRET_ENV = /^[A-Z][A-Z0-9_]{1,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** The `errors.reporter` slot's schema (unknown keys kept). */
export const errorReporterSchema = z
  .looseObject({
    apiVersion: z
      .custom<typeof ERROR_REPORTER_API_VERSION>((v) => v === ERROR_REPORTER_API_VERSION, {
        error: (iss) => `${JSON.stringify(iss.input) ?? typeof iss.input} is not an error reporter API this server implements (${ERROR_REPORTER_API_VERSION})`,
      })
      .optional(),
    id: z.string().regex(ERROR_REPORTER_ID_RE, 'id must be 2–16 lowercase letters and digits, starting with a letter'),
    label: z.string().min(1).max(40).refine((l) => !CONTROL.test(l) && l.trim() === l, 'label must be one trimmed line'),
    secrets: z
      .array(z.string().regex(SECRET_ENV, 'a secret is the name of an UPPER_SNAKE env var'))
      .max(20)
      .refine((names) => new Set(names).size === names.length, 'secrets name an env var twice')
      .optional(),
    report: z.custom<ErrorReporter['report']>((v) => typeof v === 'function', 'report must be a function'),
  }) as unknown as ZodType<ErrorReporter>;

/** The slots core itself hosts (a module contributes to them without a host module). */
export const CORE_SLOTS: Readonly<Record<string, ModuleSlot>> = Object.freeze({
  [ERROR_REPORTER_SLOT]: {
    schema: errorReporterSchema,
    unique: 'id',
    description:
      'Where the server reports its errors besides the log (Sentry, a webhook, …), chosen with ERROR_REPORTER=<id>: report(event, { secrets, signal }). Secrets are the operator env vars it declares.',
  },
});

/** Every active module's `errors.reporter` contribution with its module (already checked against the slot at load). */
function contributedReporters(modules: AnyModule[]): { module: string; reporter: ErrorReporter }[] {
  return modules.flatMap((m) => {
    const value = m.contributes?.[ERROR_REPORTER_SLOT];
    return value === undefined ? [] : [{ module: m.name, reporter: value as ErrorReporter }];
  });
}

/**
 * The reporter ERROR_REPORTER selects, or null when it is unset (errors are
 * only logged). Refuses the start (ModuleLoadError) when no active module
 * contributes that id or the server env lacks one of its secrets. The env
 * value itself is never echoed — the message lists the ids that are available.
 */
export function selectErrorReporter(modules: AnyModule[], env: NodeJS.ProcessEnv = process.env): { module: string; reporter: ErrorReporter } | null {
  const id = errorReporterId(env);
  if (id === null) return null;
  const all = contributedReporters(modules);
  const hit = all.find((c) => c.reporter.id === id);
  if (!hit) {
    const ids = all.map((c) => c.reporter.id);
    throw new ModuleLoadError(
      `ERROR_REPORTER names no error reporter of the active modules (available: ${ids.length > 0 ? ids.join(', ') : 'none'}) — add the module that contributes it to DROBEK_MODULES, or unset ERROR_REPORTER to only log errors`
    );
  }
  const missing = missingReporterSecrets(hit.reporter, env);
  if (missing.length > 0) {
    throw new ModuleLoadError(
      `the error reporter "${hit.reporter.id}" (module "${hit.module}") needs ${missing.join(', ')} in the server env — set ${missing.length > 1 ? 'them' : 'it'}, or unset ERROR_REPORTER`
    );
  }
  return hit;
}

/** Select the reporter (see `selectErrorReporter`) and install it into @drobek/core — or uninstall when ERROR_REPORTER is unset. */
export function installModuleErrorReporter(modules: AnyModule[], env: NodeJS.ProcessEnv = process.env, log?: Logger): ErrorReporter | null {
  const hit = selectErrorReporter(modules, env);
  try {
    installErrorReporter(hit?.reporter ?? null, env, log);
  } catch (err) {
    throw new ModuleLoadError((err as Error).message);
  }
  if (hit) log?.info('server errors are reported through a module', { reporter: hit.reporter.id, module: hit.module });
  return hit?.reporter ?? null;
}
