/**
 * LIMITS — the caps an agent can hit, surfaced in llms-full.txt and the
 * briefing (M0-05). agent-dx is a zero-dependency leaf, so the defaults are
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
/** write_files: max length of `reasoning`. */
export const REASONING_MAX_CHARS = 300;
/** The single-writer lease on an app, renewed by every write. */
export const APP_LOCK_TTL_SEC = 180;

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
    env: 'tool: write_files files',
    default: String(WRITE_FILES_MAX),
    meaning: 'Max changed files per write_files call (more → invalid_params).',
  },
  {
    env: 'tool: write_files reasoning',
    default: `${REASONING_MAX_CHARS} characters`,
    meaning: 'Max length of the reasoning line.',
  },
  {
    env: 'tool: single-writer lease',
    default: `${APP_LOCK_TTL_SEC} s`,
    meaning: "How long an app stays locked to one user after that user's last write (→ app_locked for others).",
  },
];
