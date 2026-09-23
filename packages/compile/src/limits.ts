export interface CompileLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxImportDepth: number;
  timeoutMs: number;
  concurrency: number;
  queueTimeoutMs: number;
}

export const DEFAULT_LIMITS: CompileLimits = {
  maxFiles: 200,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
  maxImportDepth: 50,
  timeoutMs: 10_000,
  concurrency: 4,
  queueTimeoutMs: 10_000,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** `COMPILE_*` env overrides on top of the defaults. */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): CompileLimits {
  return {
    maxFiles: positiveInt(env.COMPILE_MAX_FILES, DEFAULT_LIMITS.maxFiles),
    maxFileBytes: positiveInt(env.COMPILE_MAX_FILE_BYTES, DEFAULT_LIMITS.maxFileBytes),
    maxTotalBytes: positiveInt(env.COMPILE_MAX_TOTAL_BYTES, DEFAULT_LIMITS.maxTotalBytes),
    maxImportDepth: positiveInt(env.COMPILE_MAX_IMPORT_DEPTH, DEFAULT_LIMITS.maxImportDepth),
    timeoutMs: positiveInt(env.COMPILE_TIMEOUT_MS, DEFAULT_LIMITS.timeoutMs),
    concurrency: positiveInt(env.COMPILE_CONCURRENCY, DEFAULT_LIMITS.concurrency),
    queueTimeoutMs: positiveInt(env.COMPILE_QUEUE_TIMEOUT_MS, DEFAULT_LIMITS.queueTimeoutMs),
  };
}
