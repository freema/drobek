/**
 * The browser half of the data module: bundled into `/__drobek/sdk.js` as
 * `drobek.data` by the drobek server at start. `drobek.data.collection(name)`
 * returns a typed handle for one collection the app's config declares.
 */
import type { SdkCore } from '@drobek/sdk/core';

type Scalar = string | number | boolean | null;

export type Doc<T> = T & { _id: string; _owner?: string | null; _created_at: string; _updated_at: string };

export type Condition =
  | Scalar
  | { eq?: Scalar; ne?: Scalar; gt?: number | string; gte?: number | string; lt?: number | string; lte?: number | string; in?: Scalar[]; contains?: Scalar };

export type Filter<T> = { [K in keyof T]?: Condition };

export interface ListOptions<T> {
  filter?: Filter<T>;
  sort?: (keyof T & string) | '_id' | '_created_at' | '_updated_at';
  dir?: 'asc' | 'desc';
  limit?: number;
  cursor?: string | null;
}

export interface Page<T> {
  records: Doc<T>[];
  next_cursor: string | null;
}

export interface Collection<T> {
  list(opts?: ListOptions<T>): Promise<Page<T>>;
  get(id: string): Promise<Doc<T>>;
  create(fields: T): Promise<Doc<T>>;
  update(id: string, fields: Partial<T>): Promise<Doc<T>>;
  remove(id: string): Promise<{ id: string; deleted: true }>;
  exportCsvUrl(opts?: Pick<ListOptions<T>, 'filter' | 'sort' | 'dir'>): string;
}

export interface DataApi {
  collection<T extends object = Record<string, unknown>>(name: string): Collection<T>;
}

function listQuery(opts: ListOptions<unknown>) {
  return {
    filter: opts.filter && Object.keys(opts.filter).length > 0 ? JSON.stringify(opts.filter) : undefined,
    sort: opts.sort as string | undefined,
    dir: opts.dir,
    limit: opts.limit,
    cursor: opts.cursor ?? undefined,
  };
}

export default function data(core: SdkCore): DataApi {
  return {
    collection<T extends object>(name: string): Collection<T> {
      const base = `/${encodeURIComponent(name)}`;
      const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
      return {
        list: (opts = {}) => core.request('GET', base, { query: listQuery(opts as ListOptions<unknown>) }),
        get: (id) => core.request('GET', one(id)),
        create: (fields) => core.request('POST', base, { body: fields }),
        update: (id, fields) => core.request('PATCH', one(id), { body: fields }),
        remove: (id) => core.request('DELETE', one(id)),
        exportCsvUrl: (opts = {}) => {
          const q = listQuery(opts as ListOptions<unknown>);
          return core.url(`${base}/export.csv`, { filter: q.filter, sort: q.sort, dir: q.dir });
        },
      };
    },
  };
}
