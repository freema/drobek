/**
 * Where asset bytes live (NSO-358): `ASSETS_DIR/<app_id>/<storage_key>` on
 * the data volume (default `/data/assets`, the `assets_data` volume in the
 * production compose — part of `task backup`).
 *
 * An upload streams into `ASSETS_DIR/tmp/<uuid>.part` while it is hashed,
 * counted and sniffed — never buffered in memory — and only a complete,
 * accepted upload is renamed to its final place (atomic: tmp is on the same
 * filesystem). An aborted, oversized or refused upload removes its temp file.
 * The storage key is the bytes' sha256 (NSO-362; rows from before it keep a
 * random key), so a file is never rewritten with other bytes: replacing an
 * asset points its row at another file, and the old one is removed only when
 * neither the draft nor a published set references it (an open read stream
 * keeps its bytes until it ends).
 */
import { createHash, randomBytes, randomUUID, type Hash } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { assetsDir } from './config.js';

const KEY_RE = /^[a-z0-9]{16,64}$/;
const APP_ID_RE = /^[a-z0-9]{1,64}$/;

/** A fresh random storage key (never derived from the name). */
export function newStorageKey(): string {
  return randomBytes(16).toString('hex');
}

/** One upload in progress: sha256 + size while it streams into its temp file. */
export class AssetWriter {
  private fh: FileHandle | null = null;
  private readonly hash: Hash = createHash('sha256');
  private done = false;
  size = 0;

  constructor(
    private readonly disk: AssetDisk,
    readonly tmpPath: string
  ) {}

  async write(chunk: Buffer): Promise<void> {
    if (this.done) throw new Error('AssetWriter: write after commit/abort');
    if (!this.fh) {
      await mkdir(this.disk.tmpDir, { recursive: true });
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

  /** Move the finished upload to `<app_id>/<key>`. */
  async commit(appId: string, key: string): Promise<void> {
    const target = this.disk.pathOf(appId, key);
    await mkdir(join(this.disk.root, appId), { recursive: true });
    await rename(this.tmpPath, target);
    this.done = true;
  }

  /** Throw the upload away (idempotent; a no-op after commit). */
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

export class AssetDisk {
  constructor(readonly root: string) {}

  get tmpDir(): string {
    return join(this.root, 'tmp');
  }

  /** `<root>/<app_id>/<key>` — both parts are checked, nothing from a request reaches the path unvalidated. */
  pathOf(appId: string, key: string): string {
    if (!APP_ID_RE.test(appId) || !KEY_RE.test(key)) throw new Error('AssetDisk: bad path part');
    return join(this.root, appId, key);
  }

  begin(): AssetWriter {
    return new AssetWriter(this, join(this.tmpDir, `${randomUUID()}.part`));
  }

  /**
   * A read stream of bytes `start..end` (inclusive; default the whole file),
   * or null when the file is missing. The file is OPENED before the caller
   * sends a header, so a file removed a moment later still streams in full,
   * and a file already gone is a clean null (→ 404), never a reset mid-200.
   */
  async open(appId: string, key: string, range?: { start: number; end: number }): Promise<ReadStream | null> {
    let fh: FileHandle;
    try {
      fh = await open(this.pathOf(appId, key), 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      if (!(await fh.stat()).isFile()) {
        await fh.close();
        return null;
      }
    } catch (err) {
      await fh.close().catch(() => {});
      throw err;
    }
    return fh.createReadStream(range ? { start: range.start, end: range.end } : {});
  }

  /** Is a file stored under `<app_id>/<key>`? */
  async has(appId: string, key: string): Promise<boolean> {
    try {
      return (await stat(this.pathOf(appId, key))).isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Delete one stored file (idempotent). */
  async remove(appId: string, key: string): Promise<void> {
    await rm(this.pathOf(appId, key), { force: true });
  }

  /** Delete every stored file of an app (idempotent). */
  async removeApp(appId: string): Promise<void> {
    if (!APP_ID_RE.test(appId)) throw new Error('AssetDisk: bad app id');
    await rm(join(this.root, appId), { recursive: true, force: true });
  }
}

/** The store over the operator's ASSETS_DIR. */
export function assetDisk(env: NodeJS.ProcessEnv = process.env): AssetDisk {
  return new AssetDisk(assetsDir(env));
}
