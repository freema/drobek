/**
 * Storage quota for the Data API (U10, PHY-55) — env-driven caps enforced on
 * EVERY write regardless of the collection access mode (the editor controls
 * openness; drobek always caps abuse). PURE decisions, unit tested.
 *
 *   DATA_MAX_DOC_BYTES      — hard cap on one document's JSON byte size.
 *   DATA_MAX_DOCS_PER_APP   — hard cap on the number of live docs per app.
 *   DATA_MAX_BYTES_PER_APP  — hard cap on the summed live-doc bytes per app.
 */
import { DataError } from './errors.js';

export const DEFAULT_MAX_DOC_BYTES = 100 * 1024; // 100 KiB per document
export const DEFAULT_MAX_DOCS_PER_APP = 10_000;
export const DEFAULT_MAX_BYTES_PER_APP = 50 * 1024 * 1024; // 50 MiB per app

export interface DataQuotaLimits {
  maxDocBytes: number;
  maxDocsPerApp: number;
  maxBytesPerApp: number;
}

function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function dataQuotaFromEnv(
  env: NodeJS.ProcessEnv = process.env
): DataQuotaLimits {
  return {
    maxDocBytes: intEnv(env.DATA_MAX_DOC_BYTES, DEFAULT_MAX_DOC_BYTES),
    maxDocsPerApp: intEnv(env.DATA_MAX_DOCS_PER_APP, DEFAULT_MAX_DOCS_PER_APP),
    maxBytesPerApp: intEnv(env.DATA_MAX_BYTES_PER_APP, DEFAULT_MAX_BYTES_PER_APP),
  };
}

/** UTF-8 byte size of a document's canonical JSON form. */
export function docByteSize(doc: unknown): number {
  return Buffer.byteLength(JSON.stringify(doc), 'utf8');
}

/**
 * Decide whether a write is within quota. Throws the matching DataError.
 * - `newDocBytes` — size of the doc being written.
 * - `liveDocCount` — current live (non-deleted) doc count for the app.
 * - `liveBytesExcludingTarget` — summed live-doc bytes for the app EXCLUDING
 *   the row being replaced (0 for a create).
 * - `isCreate` — a create also consumes one more doc slot.
 */
export function enforceWriteQuota(input: {
  limits: DataQuotaLimits;
  newDocBytes: number;
  liveDocCount: number;
  liveBytesExcludingTarget: number;
  isCreate: boolean;
}): void {
  const { limits, newDocBytes, liveDocCount, liveBytesExcludingTarget, isCreate } =
    input;

  if (newDocBytes > limits.maxDocBytes) {
    throw new DataError(
      'doc_too_large',
      `document is ${newDocBytes} bytes; the per-document cap is ${limits.maxDocBytes}`
    );
  }
  if (isCreate && liveDocCount >= limits.maxDocsPerApp) {
    throw new DataError(
      'too_many_docs',
      `this app already has ${liveDocCount} documents; the cap is ${limits.maxDocsPerApp}`
    );
  }
  if (liveBytesExcludingTarget + newDocBytes > limits.maxBytesPerApp) {
    throw new DataError(
      'app_too_large',
      `this write would exceed the per-app storage cap of ${limits.maxBytesPerApp} bytes`
    );
  }
}
