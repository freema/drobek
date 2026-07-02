/**
 * Signed-upload sink — `PUT /__upload/<hmac-token>` (D2, PHY-100 CRIT).
 *
 * Order of operations is the security contract:
 *   1. verify token signature + expiry BEFORE touching the body
 *      (bad signature/malformed → 401, expired → 403),
 *   2. stream-hash the body while enforcing the TOKEN's maxBytes cap
 *      mid-stream (abort → 413) — never the client-declared length,
 *   3. compare the computed digest to the token-embedded sha256 —
 *      mismatch → 422 and NOTHING persisted (tmp cleaned by the store),
 *   4. only then commit: blob file + `blobs` metadata row upsert.
 *
 * The client manifest / headers are never trusted: `size` is the counted
 * byte total, the file only lands under its verified content address.
 */
import type { ActionFunctionArgs } from 'react-router';
import { blobs, getDb } from '@drobek/db';
import {
  createBlobStoreFromEnv,
  verifyUploadToken,
  type BlobStore,
} from '@drobek/core';

let store: BlobStore | null = null;
function getStore(): BlobStore {
  store ??= createBlobStoreFromEnv();
  return store;
}

function jsonError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function loader(): Promise<Response> {
  return jsonError(405, 'method-not-allowed');
}

export async function action({
  request,
  params,
}: ActionFunctionArgs): Promise<Response> {
  if (request.method !== 'PUT') {
    return jsonError(405, 'method-not-allowed');
  }

  const secret = process.env.UPLOAD_SIGNING_SECRET;
  if (!secret) {
    console.error('upload: UPLOAD_SIGNING_SECRET is not configured');
    return jsonError(500, 'server-misconfigured');
  }

  // 1. Token first — an invalid/expired token is rejected without reading
  //    the body any further than the request line already forced us to.
  const verdict = verifyUploadToken(params.token ?? '', secret);
  if (!verdict.ok) {
    return jsonError(
      verdict.reason === 'expired' ? 403 : 401,
      `token-${verdict.reason}`
    );
  }
  const { sha256, maxBytes } = verdict.payload;

  // Cheap early reject when the DECLARED length already exceeds the signed
  // cap. Purely an optimization — the mid-stream cap below is authoritative.
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return jsonError(413, 'max-bytes-exceeded');
  }

  try {
    // 2+3. The store stream-hashes, enforces maxBytes mid-stream, and only
    // commits (atomic rename) when the digest matches — PHY-100.
    const result = await getStore().put(
      sha256,
      request.body ?? new Uint8Array(0),
      { maxBytes }
    );

    // 4. Metadata row (bytes live on disk — D2: no bytea, ever).
    const contentType =
      request.headers.get('content-type') || 'application/octet-stream';
    const row = {
      contentType,
      size: result.size,
      path: result.relPath,
    };
    await getDb()
      .insert(blobs)
      .values({ sha256, ...row })
      .onConflictDoUpdate({ target: blobs.sha256, set: row });

    return Response.json({ ok: true, sha256 });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'BLOB_SIZE_EXCEEDED') {
      return jsonError(413, 'max-bytes-exceeded');
    }
    if (code === 'BLOB_HASH_MISMATCH') {
      return jsonError(422, 'sha256-mismatch');
    }
    console.error('upload: unexpected failure', err);
    return jsonError(500, 'upload-failed');
  }
}
