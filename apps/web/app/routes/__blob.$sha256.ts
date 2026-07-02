/**
 * Skeleton blob read path — `GET /__blob/<sha256>` (P0-B).
 *
 * Proves the signed-upload round-trip: streams the stored bytes back with
 * the stored content_type, `ETag = "<sha256>"` (content address IS the
 * validator) and `X-Content-Type-Options: nosniff`. Unknown blob → 404.
 *
 * Real serving hardening (CSP, immutable caching, visibility gates, path
 * resolution) is U7 — deliberately NOT here.
 */
import type { LoaderFunctionArgs } from 'react-router';
import { eq } from 'drizzle-orm';
import { blobs, getDb } from '@drobek/db';
import { createBlobStoreFromEnv, isSha256Hex, type BlobStore } from '@drobek/core';

let store: BlobStore | null = null;
function getStore(): BlobStore {
  store ??= createBlobStoreFromEnv();
  return store;
}

function notFound(): Response {
  return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
}

export async function loader({
  request,
  params,
}: LoaderFunctionArgs): Promise<Response> {
  const sha256 = params.sha256 ?? '';
  if (!isSha256Hex(sha256)) {
    return notFound();
  }

  // Metadata row and disk file must BOTH exist — anything else is a 404.
  const [row] = await getDb()
    .select()
    .from(blobs)
    .where(eq(blobs.sha256, sha256))
    .limit(1);
  if (!row) {
    return notFound();
  }

  const etag = `"${sha256}"`;
  const headers: Record<string, string> = {
    'Content-Type': row.contentType,
    'X-Content-Type-Options': 'nosniff',
    ETag: etag,
  };

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  const stream = await getStore().getStream(sha256);
  if (!stream) {
    return notFound();
  }

  return new Response(stream, {
    status: 200,
    headers: { ...headers, 'Content-Length': String(row.size) },
  });
}
