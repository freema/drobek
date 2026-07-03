/**
 * LIMITS — the env-driven quota/cap catalogue surfaced to agents (M1b Agent DX,
 * PHY-124). Default values mirror the constants in @drobek/data (quota.ts /
 * rate-limit.ts) and @drobek/deploy (constants.ts). agent-dx is a zero-dep leaf,
 * so the defaults are restated here as documentation; the AUTHORITATIVE runtime
 * value is always the server's env var.
 */

export interface LimitDoc {
  env: string;
  default: string;
  meaning: string;
}

export const LIMITS: LimitDoc[] = [
  {
    env: 'DATA_MAX_DOCS_PER_APP',
    default: '10000',
    meaning: 'Max live documents per app (local compose sets this LOW = 5 on purpose).',
  },
  {
    env: 'DATA_MAX_DOC_BYTES',
    default: '102400 (100 KiB)',
    meaning: 'Max JSON byte size of a single document.',
  },
  {
    env: 'DATA_MAX_BYTES_PER_APP',
    default: '52428800 (50 MiB)',
    meaning: 'Max summed live-document bytes per app.',
  },
  {
    env: 'DATA_WRITE_RATE_LIMIT',
    default: '120',
    meaning: 'Writes (create/update/delete) allowed per window, per app.',
  },
  {
    env: 'DATA_WRITE_RATE_WINDOW_MS',
    default: '60000 (60 s)',
    meaning: 'The write rate-limit window.',
  },
  {
    env: 'DEPLOY_MAX_FILE_BYTES',
    default: '10485760 (10 MiB)',
    meaning: 'Max declared bytes for any single deployed file.',
  },
  {
    env: 'DEPLOY_MAX_APP_BYTES',
    default: '104857600 (100 MiB)',
    meaning: 'Max summed declared bytes for one deploy.',
  },
];
