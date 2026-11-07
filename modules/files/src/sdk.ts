/**
 * The browser half of the files module: bundled into `/__drobek/sdk.js` as
 * `drobek.files` by the drobek server at start.
 */
import type { SdkCore } from '@drobek/sdk/core';

export interface StoredFile {
  id: string;
  /** Same-origin URL of the bytes (e.g. `<img src>`). */
  url: string;
  size: number;
  /** The type drobek detected from the bytes. */
  type: string;
  name: string;
  owner: string | null;
  created_at: string;
}

export interface FilesPage {
  files: StoredFile[];
  next_cursor: string | null;
  used_bytes: number;
  quota_bytes: number;
}

export interface FilesApi {
  upload(file: Blob, opts?: { name?: string; signal?: AbortSignal }): Promise<StoredFile>;
  url(id: string): string;
  remove(id: string): Promise<{ id: string; deleted: true }>;
  list(opts?: { limit?: number; cursor?: string | null }): Promise<FilesPage>;
}

export default function files(core: SdkCore): FilesApi {
  // The server answers `/__drobek/v1/files/<id>`; the SDK's own URL also holds
  // the app's base path under path routing.
  const withUrl = (f: StoredFile): StoredFile => ({ ...f, url: core.url(`/${encodeURIComponent(f.id)}`) });
  return {
    async upload(file, opts = {}) {
      const form = new FormData();
      const name = opts.name ?? (typeof File !== 'undefined' && file instanceof File ? file.name : '') ?? '';
      form.append('file', file, name || 'file');
      return withUrl(await core.request<StoredFile>('POST', '', { body: form, signal: opts.signal }));
    },
    url: (id) => core.url(`/${encodeURIComponent(id)}`),
    remove: (id) => core.request('DELETE', `/${encodeURIComponent(id)}`),
    async list(opts = {}) {
      const page = await core.request<FilesPage>('GET', '', { query: { limit: opts.limit, cursor: opts.cursor ?? undefined } });
      return { ...page, files: page.files.map(withUrl) };
    },
  };
}
