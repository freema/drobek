/**
 * The files module's blob store (§3.4, §5.5): content-addressed files on a
 * local volume — `FILES_DIR` (default `/data/files`), one file per distinct
 * content at `<FILES_DIR>/<sha[0:2]>/<sha[2:4]>/<sha256>` (the pattern of the
 * pre-M0 `blob-store.ts`). An upload is written to `<FILES_DIR>/tmp/<uuid>.part`
 * while it is hashed and counted; only a complete, accepted upload is
 * renamed into place (atomic on one filesystem — tmp lives inside FILES_DIR).
 * An aborted, oversized, refused or failed upload removes its temp file:
 * nothing is left behind. The same bytes uploaded twice (by any app) are
 * stored once; the database (`mod_files.sha256`) holds the references.
 *
 * Backup = the volume (rsync). No S3 backend in v1.
 */
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DEFAULT_FILES_DIR = '/data/files';

const SHA256_RE = /^[0-9a-f]{64}$/;

/** The operator's FILES_DIR (read per call, so tests can point it elsewhere). */
export function filesDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FILES_DIR?.trim() || DEFAULT_FILES_DIR;
}

/** One upload in progress: hash + size as it is written to its temp file. */
export class BlobWriter {
  private fh: FileHandle | null = null;
  private readonly hash: Hash = createHash('sha256');
  private done = false;
  size = 0;

  constructor(
    private readonly store: BlobStore,
    readonly tmpPath: string
  ) {}

  /** Append a chunk (the temp file is created on the first one). */
  async write(chunk: Buffer): Promise<void> {
    if (this.done) throw new Error('BlobWriter: write after finish/abort');
    if (!this.fh) {
      await mkdir(this.store.tmpDir, { recursive: true });
      this.fh = await open(this.tmpPath, 'wx', 0o640);
    }
    this.hash.update(chunk);
    this.size += chunk.length;
    await this.fh.write(chunk);
  }

  /** Close the temp file; the sha256 of everything written. */
  async finish(): Promise<string> {
    const sha256 = this.hash.digest('hex');
    await this.fh?.close();
    this.fh = null;
    return sha256;
  }

  /**
   * Move the finished upload to its content address. When that content is
   * stored already (another upload, any app), the temp file is dropped instead.
   */
  async commit(sha256: string): Promise<void> {
    const target = this.store.pathOf(sha256);
    if (await this.store.has(sha256)) {
      await rm(this.tmpPath, { force: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await rename(this.tmpPath, target);
    }
    this.done = true;
  }

  /** Throw the upload away (idempotent; safe after commit). */
  async abort(): Promise<void> {
    if (this.fh) {
      await this.fh.close().catch(() => {});
      this.fh = null;
    }
    if (this.done) return;
    this.done = true;
    await rm(this.tmpPath, { force: true }).catch(() => {});
  }
}

export class BlobStore {
  constructor(readonly root: string) {}

  get tmpDir(): string {
    return join(this.root, 'tmp');
  }

  /** `<root>/ab/cd/<sha256>` */
  pathOf(sha256: string): string {
    if (!SHA256_RE.test(sha256)) throw new Error('BlobStore: bad sha256');
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  begin(): BlobWriter {
    return new BlobWriter(this, join(this.tmpDir, `${randomUUID()}.part`));
  }

  async has(sha256: string): Promise<boolean> {
    try {
      return (await stat(this.pathOf(sha256))).isFile();
    } catch {
      return false;
    }
  }

  /** A read stream of a stored blob, or null when it is missing. */
  async open(sha256: string): Promise<ReadStream | null> {
    if (!(await this.has(sha256))) return null;
    return createReadStream(this.pathOf(sha256));
  }

  /** Delete a blob (idempotent). */
  async remove(sha256: string): Promise<void> {
    await rm(this.pathOf(sha256), { force: true });
  }
}

/** The store over the operator's FILES_DIR. */
export function blobStore(env: NodeJS.ProcessEnv = process.env): BlobStore {
  return new BlobStore(filesDir(env));
}
