/**
 * LIMITS — the caps an agent can hit, surfaced in llms-full.txt and the
 * briefing. agent-dx is a zero-dependency leaf, so the defaults are
 * restated here: the compile ones mirror @drobek/compile `DEFAULT_LIMITS`, the
 * tool ones are the constants below, which @drobek/mcp enforces. The
 * AUTHORITATIVE runtime value of an env cap is always the server's env var
 * (the briefing renders the live values).
 */

export interface LimitDoc {
  /** Env var name, or a `tool:` label for a fixed contract limit. */
  env: string;
  default: string;
  meaning: string;
}

/** write_files: max changed files per call (1 call = 1 version = 1 compile). */
export const WRITE_FILES_MAX = 20;
/** write_files: max `edits` in one file entry. */
export const WRITE_FILES_EDITS_MAX = 50;
/** write_files: max length of `reasoning`. */
export const REASONING_MAX_CHARS = 300;
/** The single-writer lease on an app, renewed by every write. */
export const APP_LOCK_TTL_SEC = 180;
/** create_records: max new records per call (all or nothing). */
export const CREATE_RECORDS_MAX = 500;

export const LIMITS: LimitDoc[] = [
  {
    env: 'COMPILE_MAX_FILES',
    default: '200',
    meaning: 'Max files in one app version.',
  },
  {
    env: 'COMPILE_MAX_FILE_BYTES',
    default: '524288 (512 KiB)',
    meaning: 'Max bytes of a single app file.',
  },
  {
    env: 'COMPILE_MAX_TOTAL_BYTES',
    default: '5242880 (5 MiB)',
    meaning: 'Max summed bytes of one app version.',
  },
  {
    env: 'COMPILE_MAX_IMPORT_DEPTH',
    default: '50',
    meaning: 'Max depth of a relative import chain.',
  },
  {
    env: 'COMPILE_TIMEOUT_MS',
    default: '10000 (10 s)',
    meaning: 'Max duration of one build (→ timeout).',
  },
  {
    env: 'COMPILE_QUEUE_TIMEOUT_MS',
    default: '10000 (10 s)',
    meaning: 'Max wait for a compile slot when COMPILE_CONCURRENCY builds are running (→ busy).',
  },
  {
    env: 'MCP_MAX_BODY_BYTES',
    default: '10485760 (10 MiB = 2 × COMPILE_MAX_TOTAL_BYTES)',
    meaning: 'Max bytes of one MCP request, i.e. one write_files call as JSON (escaping included); a bigger one answers HTTP 413 with a JSON-RPC error and nothing is written — split the write into several calls or send `edits`.',
  },
  {
    env: 'READINESS_MAX_WARNINGS',
    default: '50',
    meaning: 'Max warnings one readiness report lists (write_files, publish); the rest are counted in `readiness.warnings_omitted`.',
  },
  {
    env: 'TYPECHECK_WORKERS',
    default: '1',
    meaning: 'Background TypeScript checks running at once (worker threads); 0 turns the check off — no `type_error` warnings, no `readiness.typecheck`.',
  },
  {
    env: 'TYPECHECK_TIMEOUT_MS',
    default: '20000 (20 s)',
    meaning: 'Time budget of one type check; after it the check stops and `readiness.typecheck` is `unavailable`.',
  },
  {
    env: 'TYPECHECK_MAX_MEMORY_MB',
    default: '512',
    meaning: 'Heap limit of a type-check worker; a check over it stops (`readiness.typecheck: unavailable`).',
  },
  {
    env: 'TYPECHECK_MAX_FILES',
    default: '150',
    meaning: 'An app with more .ts/.tsx files is not type-checked (`readiness.typecheck: unavailable`).',
  },
  {
    env: 'APPS_MAX_PER_WORKSPACE',
    default: '50',
    meaning: 'Max live (not deleted) apps in one workspace; the limits provider may set it per workspace (create_app → limit_exceeded).',
  },
  {
    env: 'DOMAINS_MAX_PER_APP',
    default: '3',
    meaning: 'Max custom domains per app, set by the owner in the dashboard; 0 = custom domains off. The limits provider may set it per workspace.',
  },
  {
    env: 'UPSTREAMS_MAX_PER_WORKSPACE',
    default: '20',
    meaning: 'Max proxy upstreams in one workspace (register_upstream → limit_exceeded); one upstream is one host. The limits provider may set it per workspace.',
  },
  {
    env: 'UPSTREAM_REGISTRATIONS_PER_HOUR',
    default: '20',
    meaning: 'Upstream registrations per workspace within the last hour, register_upstream and the dashboard together (→ rate_limited with retry_after_seconds).',
  },
  {
    env: 'APP_ASSET_MAX_BYTES',
    default: '104857600',
    meaning: 'Max bytes (100 MiB) of one app asset — a video, audio, image or font uploaded with create_asset_upload (→ asset_too_large). The limits provider may set it per workspace.',
  },
  {
    env: 'APP_ASSETS_QUOTA',
    default: '1073741824',
    meaning: 'Max bytes (1 GiB) of all assets of one app (→ asset_quota_exceeded). The limits provider may set it per workspace.',
  },
  {
    env: 'APP_ASSET_UPLOADS_PER_HOUR',
    default: '60',
    meaning: 'Upload URLs one app may get per hour (create_asset_upload → rate_limited).',
  },
  {
    env: 'DUPLICATES_PER_USER_HOUR',
    default: '10',
    meaning: 'Copies of gallery apps one person may make per hour, duplicate_app and the dashboard together (→ rate_limited).',
  },
  {
    env: 'tool: asset upload URL',
    default: '30 min, single use',
    meaning: 'How long a create_asset_upload URL stays valid; it takes exactly one PUT (a used or expired URL → upload_token_invalid).',
  },
  {
    env: 'tool: write_files files',
    default: String(WRITE_FILES_MAX),
    meaning: 'Max changed files per write_files call (more → invalid_params).',
  },
  {
    env: 'tool: write_files edits',
    default: `${WRITE_FILES_EDITS_MAX} per file`,
    meaning: 'Max edits in one `{ path, edits }` entry of write_files (more → invalid_params).',
  },
  {
    env: 'tool: write_files reasoning',
    default: `${REASONING_MAX_CHARS} characters`,
    meaning: 'Max length of the reasoning line.',
  },
  {
    env: 'tool: create_records records',
    default: String(CREATE_RECORDS_MAX),
    meaning: 'Max new records per create_records call, stored all or nothing (more → invalid_params); the data module\'s quotas (records and bytes per app, bytes per record — skill_info(\'data\')) still apply.',
  },
  {
    env: 'tool: single-writer lease',
    default: `${APP_LOCK_TTL_SEC} s`,
    meaning: "How long an app stays locked to one user after that user's last write (→ app_locked for others).",
  },
];
