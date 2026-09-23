/**
 * Storage quota — enforced on EVERY write regardless of the collection rules
 * (the owner controls openness; drobek always caps abuse). PURE decisions,
 * unit tested. The numbers are module limits (env default or the limits
 * provider, per workspace):
 *
 *   DATA_MAX_DOC_BYTES      — one record's JSON byte size.
 *   DATA_MAX_DOCS_PER_APP   — stored records per app (all collections).
 *   DATA_MAX_BYTES_PER_APP  — summed record bytes per app.
 */
import type { Limits } from '@drobek/modules';
import { DataError } from './errors.js';

export const DEFAULT_MAX_DOC_BYTES = 100 * 1024; // 100 KiB per record
export const DEFAULT_MAX_DOCS_PER_APP = 10_000;
export const DEFAULT_MAX_BYTES_PER_APP = 50 * 1024 * 1024; // 50 MiB per app

export interface DataQuotaLimits {
  maxDocBytes: number;
  maxDocsPerApp: number;
  maxBytesPerApp: number;
}

function positive(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
}

/** The quota of one workspace from its limits (missing/invalid → the defaults). */
export function dataQuotaFromLimits(limits: Limits): DataQuotaLimits {
  return {
    maxDocBytes: positive(limits.DATA_MAX_DOC_BYTES, DEFAULT_MAX_DOC_BYTES),
    maxDocsPerApp: positive(limits.DATA_MAX_DOCS_PER_APP, DEFAULT_MAX_DOCS_PER_APP),
    maxBytesPerApp: positive(limits.DATA_MAX_BYTES_PER_APP, DEFAULT_MAX_BYTES_PER_APP),
  };
}

/** UTF-8 byte size of a record's canonical JSON form. */
export function docByteSize(doc: unknown): number {
  return Buffer.byteLength(JSON.stringify(doc), 'utf8');
}

/**
 * Decide whether a write is within quota. Throws the matching DataError.
 * - `newDocBytes` — size of the record being written.
 * - `liveDocCount` — stored records of the app.
 * - `liveBytesExcludingTarget` — summed bytes of the app's records EXCLUDING
 *   the one being replaced (all of them for a create).
 * - `isCreate` — a create also takes one more record slot.
 */
export function enforceWriteQuota(input: {
  limits: DataQuotaLimits;
  newDocBytes: number;
  liveDocCount: number;
  liveBytesExcludingTarget: number;
  isCreate: boolean;
}): void {
  const { limits, newDocBytes, liveDocCount, liveBytesExcludingTarget, isCreate } = input;

  if (newDocBytes > limits.maxDocBytes) {
    throw new DataError('payload_too_large', `The record is ${newDocBytes} bytes; one record may have at most ${limits.maxDocBytes}.`, {
      details: { limit: 'DATA_MAX_DOC_BYTES', value: limits.maxDocBytes },
    });
  }
  if (isCreate && liveDocCount >= limits.maxDocsPerApp) {
    throw new DataError('quota_exceeded', `This app already stores ${liveDocCount} records; the limit is ${limits.maxDocsPerApp}.`, {
      details: { limit: 'DATA_MAX_DOCS_PER_APP', value: limits.maxDocsPerApp },
    });
  }
  if (liveBytesExcludingTarget + newDocBytes > limits.maxBytesPerApp) {
    throw new DataError('quota_exceeded', `This write would exceed the app's storage limit of ${limits.maxBytesPerApp} bytes.`, {
      details: { limit: 'DATA_MAX_BYTES_PER_APP', value: limits.maxBytesPerApp },
    });
  }
}
