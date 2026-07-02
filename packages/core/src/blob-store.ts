/**
 * D2 (ratified) blob storage — PHY-96.
 *
 * Pluggable `BlobStore` interface with the `LocalDiskBlobStore` default:
 * content-addressed files on a persistent local volume
 * (`BLOB_DIR/<first-2-hex>/<sha256>`, volume `drobek_blobs` in compose).
 * NO MinIO, NO S3, NO bytea — an `S3BlobStore` adapter is a *later* option
 * and deliberately does not exist yet.
 *
 * PHY-100 (CRIT) is enforced INSIDE `put()`: the store stream-hashes every
 * byte it receives, enforces the caller's byte cap mid-stream, and only
 * commits (atomic tmp-file → rename) when the computed digest matches the
 * addressed sha256. A mismatch or an oversized body leaves NOTHING behind.
 * The client manifest / declared headers are never trusted.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** True for a 64-char lowercase-hex sha256 (the only accepted blob key). */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_RE.test(value);
}

/** Bytes or an async byte stream (web ReadableStreams qualify). */
export type BlobData = Uint8Array | AsyncIterable<Uint8Array>;

export type BlobPutOptions = {
  /**
   * Hard byte cap enforced MID-STREAM: reading stops the moment the counted
   * bytes exceed it (PHY-100 — never buffer an unbounded body).
   */
  maxBytes?: number;
};

export type BlobPutResult = {
  sha256: string;
  /** Actual counted bytes — never the client-declared Content-Length. */
  size: number;
  /** Store-relative location (`<ab>/<sha256>`) for the blobs.path column. */
  relPath: string;
};

export interface BlobStore {
  /**
   * Store `data` under its content address. MUST stream-hash and verify the
   * digest equals `sha256` BEFORE committing; MUST leave nothing on mismatch,
   * cap breach, or error.
   */
  put(
    sha256: string,
    data: BlobData,
    opts?: BlobPutOptions
  ): Promise<BlobPutResult>;
  /** Byte stream for a stored blob, or null when unknown. */
  getStream(sha256: string): Promise<ReadableStream<Uint8Array> | null>;
  has(sha256: string): Promise<boolean>;
  /** Idempotent — deleting an unknown blob is a no-op. */
  delete(sha256: string): Promise<void>;
}

/** Computed digest of the received bytes ≠ the addressed sha256. */
export class BlobHashMismatchError extends Error {
  readonly code = 'BLOB_HASH_MISMATCH';
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(`blob hash mismatch: expected ${expected}, got ${actual}`);
    this.name = 'BlobHashMismatchError';
  }
}

/** Body exceeded the caller's byte cap — aborted mid-stream. */
export class BlobSizeExceededError extends Error {
  readonly code = 'BLOB_SIZE_EXCEEDED';
  constructor(readonly maxBytes: number) {
    super(`blob exceeds the ${maxBytes}-byte cap`);
    this.name = 'BlobSizeExceededError';
  }
}

/** Write-path key that is not a lowercase-hex sha256. */
export class InvalidSha256Error extends Error {
  readonly code = 'INVALID_SHA256';
  constructor(value: string) {
    super(`not a lowercase-hex sha256: ${JSON.stringify(value)}`);
    this.name = 'InvalidSha256Error';
  }
}

async function* chunksOf(data: BlobData): AsyncGenerator<Uint8Array> {
  if (data instanceof Uint8Array) {
    yield data;
  } else {
    yield* data;
  }
}

export class LocalDiskBlobStore implements BlobStore {
  constructor(private readonly rootDir: string) {}

  /** Sharded store-relative path: `<first-2-hex>/<sha256>`. */
  relPath(sha256: string): string {
    return `${sha256.slice(0, 2)}/${sha256}`;
  }

  private absPath(sha256: string): string {
    return join(this.rootDir, sha256.slice(0, 2), sha256);
  }

  async put(
    sha256: string,
    data: BlobData,
    opts: BlobPutOptions = {}
  ): Promise<BlobPutResult> {
    if (!isSha256Hex(sha256)) {
      throw new InvalidSha256Error(sha256);
    }
    const { maxBytes } = opts;

    // tmp lives INSIDE rootDir so the final rename stays on one filesystem
    // (rename across devices is a copy, not atomic).
    const tmpDir = join(this.rootDir, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `${sha256}.${randomUUID()}.tmp`);

    const hash = createHash('sha256');
    let size = 0;
    const fh = await open(tmpPath, 'wx');
    try {
      for await (const chunk of chunksOf(data)) {
        size += chunk.byteLength;
        if (maxBytes !== undefined && size > maxBytes) {
          // Breaking out of for-await cancels the source stream → the
          // client upload is aborted mid-flight, not buffered to completion.
          throw new BlobSizeExceededError(maxBytes);
        }
        hash.update(chunk);
        await fh.write(chunk);
      }
      await fh.close();

      const actual = hash.digest('hex');
      if (actual !== sha256) {
        throw new BlobHashMismatchError(sha256, actual);
      }

      const finalPath = this.absPath(sha256);
      await mkdir(join(this.rootDir, sha256.slice(0, 2)), { recursive: true });
      // Atomic commit; re-putting an existing blob just replaces identical
      // (verified) bytes, so last-write-wins is safe.
      await rename(tmpPath, finalPath);
      return { sha256, size, relPath: this.relPath(sha256) };
    } catch (err) {
      await fh.close().catch(() => {});
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  async getStream(
    sha256: string
  ): Promise<ReadableStream<Uint8Array> | null> {
    if (!isSha256Hex(sha256)) return null;
    const path = this.absPath(sha256);
    try {
      await stat(path);
    } catch {
      return null;
    }
    return Readable.toWeb(
      createReadStream(path)
    ) as unknown as ReadableStream<Uint8Array>;
  }

  async has(sha256: string): Promise<boolean> {
    if (!isSha256Hex(sha256)) return false;
    try {
      await stat(this.absPath(sha256));
      return true;
    } catch {
      return false;
    }
  }

  async delete(sha256: string): Promise<void> {
    if (!isSha256Hex(sha256)) return;
    await rm(this.absPath(sha256), { force: true });
  }
}

/** Default store — BLOB_DIR env, falling back to the container mount point. */
export function createBlobStoreFromEnv(): BlobStore {
  return new LocalDiskBlobStore(process.env.BLOB_DIR || '/data/blobs');
}
