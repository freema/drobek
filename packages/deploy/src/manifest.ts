/**
 * Manifest validation + dedup (U6, PHY-57 / PHY-100). Pure — the client
 * manifest is never trusted for BYTES on disk (the sink + worker verify content
 * against the sha256), but the shape/quota/index.html gate is enforced here
 * before any token is minted or row is written.
 */
import { isSha256Hex } from '@drobek/core';
import type { QuotaLimits } from './constants.js';
import { DeployError } from './errors.js';

export interface ManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * Normalize a request path: strip a leading `./` or `/`, collapse `\` → `/`,
 * reject empty, `..` traversal, and any remaining absolute form.
 */
export function normalizeManifestPath(raw: string): string {
  const p = raw.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/');
  if (p === '' || p === '.' || p.endsWith('/')) {
    throw new DeployError('invalid_manifest', `invalid file path: ${JSON.stringify(raw)}`);
  }
  const segments = p.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) {
    throw new DeployError('invalid_manifest', `unsafe file path: ${JSON.stringify(raw)}`);
  }
  return p;
}

export interface ValidatedManifest {
  entries: ManifestEntry[];
  totalBytes: number;
}

/**
 * Validate + normalize a raw manifest, enforcing:
 *  - non-empty, each entry `{path, sha256, bytes}` well-formed,
 *  - a valid lowercase-hex sha256, non-negative integer bytes,
 *  - no duplicate normalized paths,
 *  - an `index.html` at the ROOT (entry point — no config file, PHY-57),
 *  - per-file quota (`maxFileBytes`) and per-deploy quota (`maxAppBytes`).
 */
export function validateManifest(
  raw: unknown,
  limits: QuotaLimits
): ValidatedManifest {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new DeployError('invalid_manifest', 'manifest must be a non-empty array of files');
  }

  const entries: ManifestEntry[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw new DeployError('invalid_manifest', 'each manifest entry must be an object');
    }
    const { path, sha256, bytes } = item as Record<string, unknown>;
    if (typeof path !== 'string' || typeof sha256 !== 'string') {
      throw new DeployError('invalid_manifest', 'each entry needs a string path and sha256');
    }
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
      throw new DeployError('invalid_manifest', `bytes must be a non-negative integer for ${path}`);
    }
    if (!isSha256Hex(sha256)) {
      throw new DeployError('invalid_manifest', `not a lowercase-hex sha256 for ${path}`);
    }
    const norm = normalizeManifestPath(path);
    if (seenPaths.has(norm)) {
      throw new DeployError('invalid_manifest', `duplicate file path: ${norm}`);
    }
    seenPaths.add(norm);

    if (bytes > limits.maxFileBytes) {
      throw new DeployError(
        'file_too_large',
        `${norm} is ${bytes} bytes, over the ${limits.maxFileBytes}-byte per-file limit`
      );
    }
    totalBytes += bytes;
    entries.push({ path: norm, sha256, bytes });
  }

  if (totalBytes > limits.maxAppBytes) {
    throw new DeployError(
      'app_too_large',
      `deploy is ${totalBytes} bytes, over the ${limits.maxAppBytes}-byte per-deploy limit`
    );
  }

  if (!entries.some((e) => e.path === 'index.html')) {
    throw new DeployError(
      'index_html_required',
      'an index.html at the site root is required (that is the entry point — there is no config file)'
    );
  }

  return { entries, totalBytes };
}

/**
 * Dedup diff: the entries whose content (sha256) is NOT already stored, one
 * representative per unique missing sha256. Unchanged files (sha already
 * present) get NO upload — the core of the content-hash dedup contract.
 */
export function selectMissingUploads(
  entries: ManifestEntry[],
  present: ReadonlySet<string>
): ManifestEntry[] {
  const emitted = new Set<string>();
  const out: ManifestEntry[] = [];
  for (const e of entries) {
    if (present.has(e.sha256) || emitted.has(e.sha256)) continue;
    emitted.add(e.sha256);
    out.push(e);
  }
  return out;
}
