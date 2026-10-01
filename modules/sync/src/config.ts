/**
 * The sync module's per-app config:
 *
 *   { sources: { <name>: { upstream, path, method, body?, every, collection,
 *                          items, key?, mode, paused? } } }
 *
 * A source fetches JSON from `upstream` — an upstream registered in the
 * app's workspace AND assigned to the app in the proxy config (a workspace
 * admin confirmed it) — at `path`, takes the array at `items` (a dotted
 * path, '' = the response itself) and writes it into the data collection
 * `collection`: `replace` (the collection holds exactly the fetched records
 * afterwards) or `upsert` (by the `key` field). Every `every` (at least
 * SYNC_MIN_INTERVAL_MIN minutes); `paused: true` stops it.
 *
 * Changes that wait for the owner's confirmation (an editor may confirm):
 * a new source, and a changed upstream / path / method / body / collection /
 * mode — what the source fetches with the app's upstream secret and which
 * records it overwrites. `every`, `items`, `key` and `paused` apply at once.
 * A new source past SYNC_MAX_SOURCES_PER_APP, or an interval below
 * SYNC_MIN_INTERVAL_MIN, is refused.
 */
import { createHash } from 'node:crypto';
import { ModuleError, parseJobInterval, z, type ConfigFieldMeta, type ConfirmContext, type ConfirmItem, type Limits } from '@drobek/modules';

export const DEFAULT_MIN_INTERVAL_MIN = 5;
export const DEFAULT_MAX_SOURCES_PER_APP = 10;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_RECORDS_PER_RUN = 1000;
export const DEFAULT_RUNS_PER_HOUR_PER_APP = 60;
export const DEFAULT_PAUSE_AFTER_FAILURES = 5;
export const DEFAULT_NOW_PER_MINUTE = 2;
/** The schema's own cap on sources (the operator's SYNC_MAX_SOURCES_PER_APP is checked on configure). */
const MAX_SOURCES = 50;

const SOURCE_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const UPSTREAM_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
const COLLECTION_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EVERY_RE = /^[1-9]\d{0,4}(m|h|d)$/;
const ITEMS_RE = /^$|^[A-Za-z0-9_$-]+(?:\[\d+\])*(?:\.[A-Za-z0-9_$-]+(?:\[\d+\])*)*$/;
const DAY_MS = 86_400_000;

const sourceSchema = z
  .strictObject({
    upstream: z.string().regex(UPSTREAM_RE, 'the name of an upstream assigned to this app in the proxy config').meta({
      title: 'Upstream',
      description: 'The API to fetch from: an upstream of the workspace, assigned to this app in the proxy module (its key stays there).',
      'x-drobek-choices': 'upstreams',
    } satisfies ConfigFieldMeta),
    path: z
      .string()
      .max(500)
      .regex(/^\//, 'starts with /')
      .default('/')
      .meta({ title: 'Path', description: 'The path and ?query below the upstream’s base URL, e.g. /v3/players?league=1.' }),
    method: z.enum(['GET', 'POST']).default('GET').meta({ title: 'Method' }),
    body: z
      .string()
      .max(4096)
      .optional()
      .meta({ title: 'Request body', description: 'JSON text sent as is, with method POST only. Empty: no body.' }),
    every: z
      .string()
      .regex(EVERY_RE, 'a whole number of minutes, hours or days: "15m", "1h", "1d"')
      .refine((v) => (parseJobInterval(v) ?? 0) <= 30 * DAY_MS, 'at most 30 days')
      .default('1h')
      .meta({
        title: 'Schedule',
        description: 'How often the source fetches, like a cron job.',
        'x-drobek-choices': 'intervals',
        'x-drobek-min-interval': 'SYNC_MIN_INTERVAL_MIN',
      } satisfies ConfigFieldMeta),
    collection: z.string().regex(COLLECTION_RE, 'a collection declared in the data config').meta({
      title: 'Collection',
      description: 'The data collection the fetched records are written into; the app reads them from there.',
      'x-drobek-choices': 'collections',
    } satisfies ConfigFieldMeta),
    items: z
      .string()
      .max(200)
      .regex(ITEMS_RE, 'a dotted path such as "data.players" (or "" for the response itself)')
      .default('')
      .meta({
        title: 'Records in the answer',
        description: 'Where the list of records is in the JSON answer, e.g. data.players or results[0].items. Empty: the answer itself is the list.',
      }),
    key: z
      .string()
      .regex(FIELD_RE, 'a field name (letters, digits, - and _, a letter first)')
      .optional()
      .meta({
        title: 'Record key',
        description: 'The field that identifies a record, e.g. id. Needed for mode upsert; with replace it is optional (then every record must have a unique one).',
      }),
    mode: z.enum(['replace', 'upsert']).default('replace').meta({
      title: 'Mode',
      description: 'replace: afterwards the collection holds exactly the fetched records. upsert: records are updated by their key, new ones added, none removed.',
    }),
    paused: z
      .boolean()
      .optional()
      .meta({ title: 'Paused', description: 'The schedule stops; Run now still works. Pause schedule and Resume schedule under Sources set it too.' }),
  })
  .refine((s) => s.mode !== 'upsert' || s.key !== undefined, { message: 'mode "upsert" needs `key`: the field that identifies a record', path: ['key'] })
  .refine((s) => s.body === undefined || s.method === 'POST', { message: 'a body is sent with method "POST" only', path: ['body'] });

export type SyncSource = z.infer<typeof sourceSchema>;

export const syncConfigSchema = z.strictObject({
  sources: z
    .record(
      z
        .string()
        .regex(SOURCE_NAME_RE, 'a source name: lowercase letters, digits, - and _, a letter first')
        .meta({ title: 'Source name', description: 'Lowercase letters, digits, - and _, a letter first, e.g. players.' }),
      sourceSchema
    )
    .refine((s) => Object.keys(s).length <= MAX_SOURCES, `at most ${MAX_SOURCES} sources`)
    .default({})
    .meta({
      title: 'Sources',
      description: 'Each source fetches JSON from an upstream on its schedule and writes the records into a data collection. A new source, or a change of what it fetches or writes, waits for confirmation.',
    }),
});

export type SyncConfig = z.infer<typeof syncConfigSchema>;

export const SYNC_CONFIG_DEFAULTS: SyncConfig = { sources: {} };

function positive(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
}

export interface SyncLimits {
  minIntervalMin: number;
  maxSources: number;
  maxResponseBytes: number;
  maxRecordsPerRun: number;
  runsPerHour: number;
  pauseAfterFailures: number;
  nowPerMinute: number;
}

/** The module's limits of one workspace (missing/invalid → the defaults). */
export function syncLimits(limits: Limits): SyncLimits {
  return {
    minIntervalMin: positive(limits.SYNC_MIN_INTERVAL_MIN, DEFAULT_MIN_INTERVAL_MIN),
    maxSources: positive(limits.SYNC_MAX_SOURCES_PER_APP, DEFAULT_MAX_SOURCES_PER_APP),
    maxResponseBytes: positive(limits.SYNC_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES),
    maxRecordsPerRun: positive(limits.SYNC_MAX_RECORDS_PER_RUN, DEFAULT_MAX_RECORDS_PER_RUN),
    runsPerHour: positive(limits.SYNC_RUNS_PER_HOUR_PER_APP, DEFAULT_RUNS_PER_HOUR_PER_APP),
    pauseAfterFailures: positive(limits.SYNC_PAUSE_AFTER_FAILURES, DEFAULT_PAUSE_AFTER_FAILURES),
    nowPerMinute: positive(limits.SYNC_NOW_PER_MINUTE, DEFAULT_NOW_PER_MINUTE),
  };
}

/** The interval a source runs at: its `every`, raised to the operator's minimum (ms). */
export function effectiveIntervalMs(source: Pick<SyncSource, 'every'>, minIntervalMin: number): number {
  return Math.max(parseJobInterval(source.every) ?? 3_600_000, minIntervalMin * 60_000);
}

/** `every` as the interval in force, e.g. "15m" (raised to the minimum when below it). */
export function effectiveEvery(source: Pick<SyncSource, 'every'>, minIntervalMin: number): string {
  const ms = parseJobInterval(source.every) ?? 0;
  return ms >= minIntervalMin * 60_000 ? source.every : `${minIntervalMin}m`;
}

/** The sources that run, in name order (the first SYNC_MAX_SOURCES_PER_APP). */
export function activeSourceNames(config: SyncConfig, maxSources: number): string[] {
  return Object.keys(config.sources).sort().slice(0, maxSources);
}

/** The fields whose change waits for the owner (what is fetched with the secret, what is overwritten). */
const CONFIRMED_FIELDS = ['upstream', 'path', 'method', 'body', 'collection', 'mode'] as const;

function describe(s: SyncSource): string {
  const write = s.mode === 'replace' ? `replace every record of the collection "${s.collection}"` : `upsert records by "${s.key}" into the collection "${s.collection}"`;
  return `every ${s.every} ${s.method} the upstream "${s.upstream}" at ${s.path} and ${write}`;
}

/** The changes that wait for the owner (see the file header); pure. */
export function syncConfirmRequired(before: SyncConfig, after: SyncConfig): ConfirmItem[] {
  const out: ConfirmItem[] = [];
  for (const name of Object.keys(after.sources).sort()) {
    const a = after.sources[name];
    const b = Object.prototype.hasOwnProperty.call(before.sources, name) ? before.sources[name] : null;
    if (!b) {
      out.push(`sync.sources.${name}: new scheduled import — ${describe(a)}`);
      continue;
    }
    const changed = CONFIRMED_FIELDS.filter((f) => a[f] !== b[f]);
    if (changed.length > 0) out.push(`sync.sources.${name}: ${changed.join(', ')} changed — now ${describe(a)}`);
  }
  return out;
}

/**
 * configure_module's hook: refuse a new source past SYNC_MAX_SOURCES_PER_APP
 * and an interval below SYNC_MIN_INTERVAL_MIN (only where the change adds
 * it: a lowered operator limit never blocks an unrelated change), then
 * {@link syncConfirmRequired}.
 */
export async function syncConfirmRequiredIn(before: SyncConfig, after: SyncConfig, context: ConfirmContext): Promise<ConfirmItem[]> {
  const limits = syncLimits(context.limits ? await context.limits() : {});
  const count = Object.keys(after.sources).length;
  if (count > limits.maxSources && count > Object.keys(before.sources).length) {
    throw new ModuleError('invalid_params', `An app may have at most ${limits.maxSources} sync sources (SYNC_MAX_SOURCES_PER_APP); this config has ${count}.`, {
      details: { limit: 'SYNC_MAX_SOURCES_PER_APP', value: limits.maxSources },
      hint: "skill_info('sync')",
    });
  }
  const tooOften = Object.keys(after.sources)
    .sort()
    .filter((name) => {
      const a = after.sources[name];
      const b = Object.prototype.hasOwnProperty.call(before.sources, name) ? before.sources[name] : null;
      return (parseJobInterval(a.every) ?? 0) < limits.minIntervalMin * 60_000 && (!b || b.every !== a.every);
    });
  if (tooOften.length > 0) {
    throw new ModuleError(
      'invalid_params',
      `A source runs at most every ${limits.minIntervalMin} minutes (SYNC_MIN_INTERVAL_MIN): set "every" to "${limits.minIntervalMin}m" or more for ${tooOften.map((n) => `"${n}"`).join(', ')}.`,
      { details: { limit: 'SYNC_MIN_INTERVAL_MIN', value: limits.minIntervalMin, sources: tooOften }, hint: "skill_info('sync')" }
    );
  }
  return syncConfirmRequired(before, after);
}

/** A stable fingerprint of what a source fetches and writes (a change starts its failure count over). */
export function sourceHash(s: SyncSource): string {
  const text = JSON.stringify([s.upstream, s.path, s.method, s.body ?? null, s.collection, s.items, s.key ?? null, s.mode]);
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}
