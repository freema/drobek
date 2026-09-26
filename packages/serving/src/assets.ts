/**
 * App assets on the app hosts (NSO-358): `GET|HEAD /<name>` answers the app's
 * uploaded binary (video, audio, images, fonts — `@drobek/apps` assets) with
 * the bytes' SNIFFED type. Assets share the URL space of the app's files, so
 * a ported page keeps its paths (`<video src="film.mp4">`, `img/s1.jpg`).
 * Reached from handler.ts only after the app, takedown, password gate and
 * version steps, and only when the version itself has no file at that path
 * (the app's own file wins — a version stays immutable). An asset path always
 * has a media extension, so the SPA fallback (extension-less paths only) never
 * swallows one.
 *
 *   - Range (RFC 9110, one range): `206` + `Content-Range`, `416` + `bytes
 *     *\/<size>` for an unsatisfiable one; a multi-range list gets the whole
 *     file (200). `Accept-Ranges: bytes` on every answer — Safari will not
 *     play a video without it.
 *   - ETag = the sha256 (304 on If-None-Match), Last-Modified = the upload
 *     time (304 on If-Modified-Since when no If-None-Match); `If-Range` with a
 *     different validator falls back to the whole file.
 *   - Cache-Control: published / custom hosts `public, max-age=300,
 *     must-revalidate` (a replaced asset shows within 5 minutes), preview and
 *     version hosts revalidate on every use; a password app is `private`.
 *   - SVG (the one text type) is `attachment` with a second CSP `sandbox`,
 *     exactly like the files module: `<img src>` still shows it, opening it as
 *     a document runs no script on the app's origin.
 */
import type { Readable } from 'node:stream';
import { assetFileName, assetNameProblem, contentRange, parseRange, unsatisfiedRange, type ByteRange } from '@drobek/apps';
import { REVALIDATE_CACHE, etagFor, isNotModified } from './resolve.js';

/** One stored asset as the serving path needs it. */
export interface ServedAsset {
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  storageKey: string;
  updatedAt: Date;
}

/** Where assets come from (node.ts: the app_assets rows + the ASSETS_DIR disk). */
export interface AssetSource {
  find(appId: string, name: string): Promise<ServedAsset | null>;
  /** Bytes `range` (inclusive; default all) of a stored file, or null when it is gone. */
  open(appId: string, storageKey: string, range?: ByteRange): Promise<Readable | null>;
}

/** Published / custom hosts: shared caches keep an asset 5 minutes, then revalidate (ETag → 304). */
export const ASSET_PUBLIC_CACHE = 'public, max-age=300, must-revalidate';
const SVG_CSP = 'sandbox';

/** The asset name of a (decoded) request path — `/img/s1.jpg` → `img/s1.jpg` — or null when it cannot name an asset. */
export function assetNameOf(decodedPath: string): string | null {
  if (!decodedPath.startsWith('/')) return null;
  const name = decodedPath.slice(1);
  return assetNameProblem(name) === null ? name : null;
}

function notModifiedSince(header: string | null, updatedAt: Date): boolean {
  if (!header) return false;
  const since = Date.parse(header);
  return Number.isFinite(since) && Math.floor(updatedAt.getTime() / 1000) * 1000 <= since;
}

export interface AssetServeInput {
  method: string;
  header(name: string): string | null;
  asset: ServedAsset;
  /** Published / custom host (longer shared caching). */
  published: boolean;
  /** A password app: never in a shared cache. */
  isPrivate: boolean;
}

/** The status + headers of an asset answer, and which bytes to send (null = none). */
export function assetResponsePlan(input: AssetServeInput): {
  status: 200 | 206 | 304 | 416;
  headers: Record<string, string>;
  range: ByteRange | null;
  send: boolean;
} {
  const { asset } = input;
  const etag = etagFor(asset.sha256);
  const cache = input.published ? ASSET_PUBLIC_CACHE : REVALIDATE_CACHE;
  const headers: Record<string, string> = {
    'Content-Type': asset.contentType,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': asset.updatedAt.toUTCString(),
    'Cache-Control': input.isPrivate ? cache.replace(/^public/, 'private') : cache,
  };
  if (asset.contentType === 'image/svg+xml') {
    headers['Content-Disposition'] = `attachment; filename="${assetFileName(asset.name)}"`;
    headers['Content-Security-Policy'] = SVG_CSP;
  }
  const inm = input.header('if-none-match');
  if (inm ? isNotModified(inm, etag) : notModifiedSince(input.header('if-modified-since'), asset.updatedAt)) {
    return { status: 304, headers, range: null, send: false };
  }
  const ifRange = input.header('if-range');
  const rangeHeader = ifRange && ifRange.trim() !== etag ? null : input.header('range');
  const decision = parseRange(rangeHeader, asset.size);
  if (decision === 'unsatisfiable') {
    return {
      status: 416,
      headers: { ...headers, 'Content-Range': unsatisfiedRange(asset.size), 'Content-Length': '0' },
      range: null,
      send: false,
    };
  }
  const head = input.method.toUpperCase() === 'HEAD';
  if (decision) {
    headers['Content-Range'] = contentRange(decision, asset.size);
    headers['Content-Length'] = String(decision.end - decision.start + 1);
    return { status: 206, headers, range: decision, send: !head };
  }
  headers['Content-Length'] = String(asset.size);
  return { status: 200, headers, range: null, send: !head && asset.size > 0 };
}
