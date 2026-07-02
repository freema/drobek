import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BlobHashMismatchError,
  BlobSizeExceededError,
  InvalidSha256Error,
  isSha256Hex,
  LocalDiskBlobStore,
} from './blob-store.js';

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function* asChunks(
  data: Uint8Array,
  chunkSize: number
): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += chunkSize) {
    yield data.slice(i, i + chunkSize);
  }
}

async function collect(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) {
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/** Files left anywhere under dir (proves "nothing persisted" on failure). */
async function fileCount(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).length;
}

describe('LocalDiskBlobStore', () => {
  let dir: string;
  let store: LocalDiskBlobStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'drobek-blobs-'));
    store = new LocalDiskBlobStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('put → has → getStream round-trips bytes under the sharded path', async () => {
    const data = Buffer.from('drobek blob store test payload');
    const sha = sha256Hex(data);

    const result = await store.put(sha, data);
    expect(result).toEqual({
      sha256: sha,
      size: data.length,
      relPath: `${sha.slice(0, 2)}/${sha}`,
    });

    // Sharding: BLOB_DIR/<first-2-hex>/<sha256>
    const finalPath = join(dir, sha.slice(0, 2), sha);
    expect((await stat(finalPath)).size).toBe(data.length);

    expect(await store.has(sha)).toBe(true);
    const stream = await store.getStream(sha);
    expect(stream).not.toBeNull();
    expect(Buffer.compare(await collect(stream!), data)).toBe(0);
  });

  it('put accepts a multi-chunk async stream', async () => {
    const data = Buffer.alloc(10_000, 7);
    const sha = sha256Hex(data);

    const result = await store.put(sha, asChunks(data, 333));
    expect(result.size).toBe(data.length);
    expect(Buffer.compare(await collect((await store.getStream(sha))!), data)).toBe(0);
  });

  it('rejects a hash mismatch and persists NOTHING (tmp cleaned)', async () => {
    const data = Buffer.from('actual bytes');
    const wrongSha = sha256Hex(Buffer.from('some other bytes'));

    await expect(store.put(wrongSha, data)).rejects.toBeInstanceOf(
      BlobHashMismatchError
    );
    expect(await store.has(wrongSha)).toBe(false);
    expect(await fileCount(dir)).toBe(0);
  });

  it('enforces maxBytes mid-stream and persists NOTHING', async () => {
    const data = Buffer.alloc(4096, 1);
    const sha = sha256Hex(data);
    let yielded = 0;
    async function* counted(): AsyncGenerator<Uint8Array> {
      for await (const chunk of asChunks(data, 256)) {
        yielded += chunk.length;
        yield chunk;
      }
    }

    await expect(
      store.put(sha, counted(), { maxBytes: 1000 })
    ).rejects.toBeInstanceOf(BlobSizeExceededError);
    // Aborted mid-stream — never consumed the whole 4096-byte body.
    expect(yielded).toBeLessThan(data.length);
    expect(await store.has(sha)).toBe(false);
    expect(await fileCount(dir)).toBe(0);
  });

  it('accepts a body of exactly maxBytes', async () => {
    const data = Buffer.alloc(1000, 2);
    const sha = sha256Hex(data);
    await expect(
      store.put(sha, data, { maxBytes: 1000 })
    ).resolves.toMatchObject({ size: 1000 });
  });

  it('put is idempotent for the same content', async () => {
    const data = Buffer.from('same bytes twice');
    const sha = sha256Hex(data);
    await store.put(sha, data);
    await expect(store.put(sha, data)).resolves.toMatchObject({ sha256: sha });
    expect(await store.has(sha)).toBe(true);
  });

  it('delete removes the blob and is idempotent', async () => {
    const data = Buffer.from('to be deleted');
    const sha = sha256Hex(data);
    await store.put(sha, data);

    await store.delete(sha);
    expect(await store.has(sha)).toBe(false);
    expect(await store.getStream(sha)).toBeNull();
    await expect(store.delete(sha)).resolves.toBeUndefined(); // no-op
  });

  it('rejects non-sha256 keys on the write path, treats them as unknown on reads', async () => {
    await expect(
      store.put('../../etc/passwd', Buffer.from('x'))
    ).rejects.toBeInstanceOf(InvalidSha256Error);
    await expect(store.put('ABC123', Buffer.from('x'))).rejects.toBeInstanceOf(
      InvalidSha256Error
    );
    expect(await store.has('../../etc/passwd')).toBe(false);
    expect(await store.getStream('not-hex')).toBeNull();
    await expect(store.delete('not-hex')).resolves.toBeUndefined();
  });
});

describe('isSha256Hex', () => {
  it('accepts exactly 64 lowercase hex chars', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex(sha256Hex(Buffer.from('x')))).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isSha256Hex('')).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
    expect(isSha256Hex('a'.repeat(65))).toBe(false);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('g'.repeat(64))).toBe(false);
  });
});
