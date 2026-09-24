/**
 * drobek-module-data — the BUILT-IN platform module `data` (M1-03, §5.2):
 * per-app collections of JSON records with per-operation rules.
 *
 *   DROBEK_MODULES=…,data  → this package (`modules/data` in the drobek repo,
 *                            a dependency of the server).
 *
 *   GET/POST          /__drobek/v1/data/:collection
 *   GET/PATCH/DELETE  /__drobek/v1/data/:collection/:id
 *   GET               /__drobek/v1/data/:collection/export.csv   (admin)
 *   drobek.data.collection(name).list() / get() / create() / update() / remove() / exportCsvUrl()
 *   config { collections: { <name>: { schema?, rules: { read, create, update, delete } } } }
 *   records authority → MCP query_data and the dashboard Data tab (the owner's view).
 *
 * Opening an operation to `public`, `update`/`delete` to every signed-in
 * user, dropping the schema of a collection that holds records, or removing
 * such a collection (its records are purged on confirmation) needs the
 * owner's confirmation. Records of an app are shared by its preview and
 * production hosts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineModule } from '@drobek/modules';
import { DATA_CONFIG_DEFAULTS, dataConfigSchema, dataConfirmRequired, dataOnConfirmed, salvageDataConfig, type DataConfig } from './config.js';
import { DEFAULT_MAX_BYTES_PER_APP, DEFAULT_MAX_DOC_BYTES, DEFAULT_MAX_DOCS_PER_APP } from './quota.js';
import { recordsAuthority } from './records.js';
import { DEFAULT_WRITES_PER_PRINCIPAL_PER_MIN, DEFAULT_WRITE_RATE_LIMIT, DEFAULT_WRITE_RATE_WINDOW_MS, registerRoutes } from './routes.js';

export { DEFAULT_RULES, LEGACY_ACCESS_MODES, OPS, accessModeToRules, decideRecord, listScope, ruleAdmits, type Op, type Rules } from './access.js';
export { SYSTEM_COLUMNS, cellText, csvHeader, csvRecordLine, schemaColumns, type SchemaColumn } from './columns.js';
export {
  COLLECTION_NAME_RE,
  DATA_CONFIG_DEFAULTS,
  MAX_COLLECTIONS,
  collectionConfig,
  collectionConfigSchema,
  dataConfigSchema,
  dataConfirmRequired,
  rulesOf,
  salvageDataConfig,
  type CollectionConfig,
  type DataConfig,
} from './config.js';
export { DataError, dataErrorStatus, type DataErrorCode } from './errors.js';
export * from './query-build.js';
export * from './quota.js';
export { recordsAuthority } from './records.js';
export { clientFields } from './routes.js';
export { compileSchema, schemaPropertyNames, validateDocument } from './schema-validate.js';
export { dataRecords, type DataRecordRow } from './schema.js';
export { countRecords, toRecord, type DataRecord } from './store.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The SDK entry next to this file: dist/sdk.js when built, src/sdk.ts in a source checkout. */
const sdkEntry = existsSync(here('./sdk.js')) ? here('./sdk.js') : here('./sdk.ts');

export const SDK_TYPES = `
export type Scalar = string | number | boolean | null;
/** A stored record: the server's fields (_…) plus yours. _owner is left out for a visitor who is not signed in. */
export type Doc<T> = T & { _id: string; _owner?: string | null; _created_at: string; _updated_at: string };
/** A value (equality) or operators: eq ne gt gte lt lte in contains. */
export type Condition =
  | Scalar
  | { eq?: Scalar; ne?: Scalar; gt?: number | string; gte?: number | string; lt?: number | string; lte?: number | string; in?: Scalar[]; contains?: Scalar };
export type Filter<T> = { [K in keyof T]?: Condition };
export interface ListOptions<T> {
  filter?: Filter<T>;
  /** Default: _created_at, newest first. */
  sort?: (keyof T & string) | '_id' | '_created_at' | '_updated_at';
  dir?: 'asc' | 'desc';
  /** 1–200, default 50. */
  limit?: number;
  /** next_cursor of the previous page. */
  cursor?: string | null;
}
export interface Page<T> { records: Doc<T>[]; next_cursor: string | null }
export interface Collection<T> {
  /** Under a read rule with owner (e.g. "owner|admin") a user gets only their own records. */
  list(opts?: ListOptions<T>): Promise<Page<T>>;
  get(id: string): Promise<Doc<T>>;
  /** _owner = the signed-in user (null for a visitor). Keys starting with _ are dropped. */
  create(fields: T): Promise<Doc<T>>;
  /** Shallow merge of the given fields. */
  update(id: string, fields: Partial<T>): Promise<Doc<T>>;
  remove(id: string): Promise<{ id: string; deleted: true }>;
  /** The CSV export URL (admins only), e.g. for <a href download>. */
  exportCsvUrl(opts?: Pick<ListOptions<T>, 'filter' | 'sort' | 'dir'>): string;
}
export interface Api {
  /** A collection the app's config declares. */
  collection<T extends object = Record<string, unknown>>(name: string): Collection<T>;
}
`;

const data = defineModule<DataConfig>({
  name: 'data',
  version: '1.0.0',
  skill: {
    useWhen: 'the app stores records (lists, todos, entries, votes, a shared or per-user database) — instead of Firebase, Supabase or localStorage',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  configSchema: dataConfigSchema,
  configDefaults: DATA_CONFIG_DEFAULTS,
  salvageConfig: salvageDataConfig,
  confirmRequired: dataConfirmRequired,
  onConfirmed: dataOnConfirmed,
  rules: {
    ops: {
      read: 'List and get records (owner = only the caller’s own)',
      create: 'Add a record (the signed-in creator becomes its _owner)',
      update: 'Change a record’s fields (owner = the stored _owner)',
      delete: 'Delete a record (owner = the stored _owner)',
    },
  },
  limits: [
    { env: 'DATA_MAX_DOC_BYTES', default: DEFAULT_MAX_DOC_BYTES, meaning: 'bytes of one record (its JSON)' },
    { env: 'DATA_MAX_DOCS_PER_APP', default: DEFAULT_MAX_DOCS_PER_APP, meaning: 'records one app may store (all collections)' },
    { env: 'DATA_MAX_BYTES_PER_APP', default: DEFAULT_MAX_BYTES_PER_APP, meaning: 'bytes of records one app may store' },
    { env: 'DATA_WRITE_RATE_LIMIT', default: DEFAULT_WRITE_RATE_LIMIT, meaning: 'record writes (create, update, delete) one app may take per window' },
    { env: 'DATA_WRITE_RATE_WINDOW_MS', default: DEFAULT_WRITE_RATE_WINDOW_MS, meaning: 'the write rate-limit window in milliseconds' },
    {
      env: 'DATA_WRITES_PER_PRINCIPAL_PER_MIN',
      default: DEFAULT_WRITES_PER_PRINCIPAL_PER_MIN,
      meaning: 'record writes one signed-in user (or one visitor IP) may make per minute, checked before the per-app limit',
    },
  ],
  routes: registerRoutes,
  records: recordsAuthority,
  sdk: { entry: sdkEntry, types: SDK_TYPES },
  migrations: { folder: here('../migrations') },
});

export default data;
