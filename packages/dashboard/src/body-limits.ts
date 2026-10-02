/**
 * The dashboard paths whose routes take request bodies larger than the
 * server's dashboard cap (DASHBOARD_MAX_BODY_BYTES) and enforce their own
 * limit: the Data tab's collection page, whose CSV import takes a file of up
 * to IMPORT_MAX_BYTES. The server leaves these paths to their routes, and the
 * generated Caddyfile exempts the same paths (DASHBOARD_BODY_CAP_EXEMPT_PATHS
 * in @drobek/core). Imports nothing but owner-view, so the Express app loads
 * it without the route modules.
 */
import { IMPORT_MAX_BYTES } from './owner-view.js';

/** The most bytes a CSV import request may carry: the file plus the form's other fields and the multipart framing. */
export const IMPORT_REQUEST_MAX_BYTES = IMPORT_MAX_BYTES + 64 * 1024;

/** `/workspaces/:slug/apps/:appSlug/data/:collection`, also as React Router's `.data` request; matched on a normalized path. */
const COLLECTION_PAGE = /^\/workspaces\/[^/]+\/apps\/[^/]+\/data\/[^/]+\/?$/i;

/** True for a path whose route enforces its own, larger body limit. */
export function hasOwnBodyLimit(pathname: string): boolean {
  return COLLECTION_PAGE.test(pathname);
}

/**
 * The request body when it is at most `max` bytes, counted as it is read;
 * null past it. The rest of a too-large body is still read and dropped, so
 * the route's answer reaches the client instead of a reset connection.
 */
export async function readBodyUpTo(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size <= max) chunks.push(value);
  }
  if (size > max) return null;
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return body;
}
