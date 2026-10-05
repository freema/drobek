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
/** read_file: max paths in one call. */
export const READ_FILE_PATHS_MAX = 20;
/** read_file with `search`: the matching lines returned by default, and at most. */
export const READ_FILE_SEARCH_MATCHES_DEFAULT = 50;
export const READ_FILE_SEARCH_MATCHES_MAX = 100;
/** read_file with `search`: max length of the text searched for. */
export const READ_FILE_SEARCH_MAX_CHARS = 200;
/** create_records: max new records per call (all or nothing). */
export const CREATE_RECORDS_MAX = 500;
/** The owner's list tools (form submissions, end users, uploads, activity): max entries per call. */
export const OWNER_LIST_MAX = 100;
/** The owner's list tools: max bytes of the entries' JSON in one answer (a longer page is cut, next_cursor continues it). */
export const OWNER_LIST_MAX_BYTES = 64 * 1024;

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
    env: 'VERSIONS_PER_APP_HOUR',
    default: '600',
    meaning: 'New versions of one app within the last hour — write_files, create_app, restore_version, duplicate_app and the dashboard\'s Restore together (→ rate_limited with retry_after_seconds; nothing is stored). The limits provider may set it per workspace.',
  },
  {
    env: 'VERSIONS_PER_USER_HOUR',
    default: '1200',
    meaning: 'New versions one person makes within the last hour, in every app and workspace (→ rate_limited with retry_after_seconds; nothing is stored). The limits provider may set it per workspace.',
  },
  {
    env: 'APP_VERSIONS_KEEP',
    default: '200',
    meaning: 'The newest versions of each app the hourly history retention keeps; older ones are deleted except the published one, the one the preview serves, the kept ones, those kept for a rollback and those from the last hour (read_file / restore_version / publish of a deleted one → not_found; get_app `version_retention`). The limits provider may set it per workspace.',
  },
  {
    env: 'APP_VERSIONS_KEPT_MAX',
    default: '20',
    meaning: 'Versions of one app its members may keep — neither the history retention nor a clean-up deletes a kept version; keeping one more → limit_exceeded with `limit` / `value` (stop keeping one first). A lower limit leaves the versions already kept alone. The limits provider may set it per workspace.',
  },
  {
    env: 'WORKSPACE_SOURCE_QUOTA',
    default: '1073741824',
    meaning: 'Max bytes (1 GiB) of the unique files — sources and build output — the versions of all live apps of one workspace store; a version whose new bytes do not fit (write_files, create_app, duplicate_app) → limit_exceeded with `used_bytes`, nothing stored. A restore adds no bytes. The limits provider may set it per workspace.',
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
    env: 'tool: read_file paths',
    default: String(READ_FILE_PATHS_MAX),
    meaning: 'Max paths in one read_file call (more → invalid_params).',
  },
  {
    env: 'tool: read_file text per call',
    default: 'COMPILE_MAX_FILE_BYTES',
    meaning: 'Text one read_file call returns: the first file always comes back, each further one only while the total stays within it — the rest is listed under `omitted` (read it in another call, or a part with offset/limit).',
  },
  {
    env: 'tool: read_file search',
    default: `${READ_FILE_SEARCH_MATCHES_DEFAULT} matching lines (limit up to ${READ_FILE_SEARCH_MATCHES_MAX}), ${READ_FILE_SEARCH_MAX_CHARS} characters`,
    meaning: 'read_file with `search`: the matching lines returned (the answer counts them all) and the longest text searched for (literal, one line).',
  },
  {
    env: 'tool: create_records records',
    default: String(CREATE_RECORDS_MAX),
    meaning: 'Max new records per create_records call, stored all or nothing (more → invalid_params); the data module\'s quotas (records and bytes per app, bytes per record — skill_info(\'data\')) still apply.',
  },
  {
    env: 'tool: owner list entries',
    default: `${OWNER_LIST_MAX} per call`,
    meaning: 'Max entries one list_form_submissions, list_end_users, list_uploads or list_activity call returns (`limit`; more → invalid_params); next_cursor pages on.',
  },
  {
    env: 'tool: owner list answer',
    default: `${OWNER_LIST_MAX_BYTES} bytes (64 KiB)`,
    meaning: 'Max JSON bytes of the entries in one answer of those four tools: a page that would be bigger ends earlier (`cut: true`) and next_cursor continues right after it; a single bigger entry has its long texts shortened (`clipped: true`).',
  },
  {
    env: 'tool: single-writer lease',
    default: `${APP_LOCK_TTL_SEC} s`,
    meaning: "How long an app stays locked to one user after that user's last write (→ app_locked for others).",
  },
];
