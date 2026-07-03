/**
 * @drobek/data — the U10 Data API v1 (PHY-55/PHY-56; PHY-63/71) as a react-free
 * workspace LIBRARY. jsonb collections with a required JSON Schema + a
 * per-collection access mode, server-side validation, a write rate-limit and a
 * storage quota, and CRUD/query over soft-deletable documents.
 *
 * The MCP tools (collection_define / record_*) are registered by
 * @drobek/oauth/resource, which calls the core functions exported here; the
 * REST endpoints live under the `@drobek/data/rest` subpath.
 */
export {
  DataError,
  dataErrorStatus,
  type DataErrorCode,
} from './errors.js';
export {
  ACCESS_MODES,
  ANON_CALLER,
  decideDataAccess,
  decideMemberDataAccess,
  isAccessMode,
  type AccessDecision,
  type AccessMode,
  type DataCaller,
  type DataOperation,
} from './access.js';
export {
  cellText,
  csvEscape,
  csvHeader,
  csvLine,
  csvRow,
  flattenDoc,
  mapFilterSort,
  schemaColumns,
  schemaSummary,
  type FilterSort,
  type FlatRow,
  type SchemaColumn,
} from './columns.js';
export {
  deleteRecordForMember,
  getCollectionForMember,
  iterateRecordsForMember,
  listCollectionsForMember,
  queryRecordsForMember,
  readRecordForMember,
  type MemberCollection,
  type MemberCollectionSummary,
  type MemberDataContext,
} from './member-view.server.js';
export {
  assertSchemaShape,
  compileSchema,
  schemaPropertyNames,
  validateDocument,
  type FieldError,
} from './schema-validate.js';
export {
  clampLimit,
  decodeCursor,
  encodeCursor,
  normalizeSort,
  normalizeWhere,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  META_SORT_FIELDS,
  type CursorState,
  type ScalarValue,
  type SortSpec,
  type WhereClause,
} from './query-build.js';
export {
  dataQuotaFromEnv,
  docByteSize,
  enforceWriteQuota,
  DEFAULT_MAX_DOC_BYTES,
  DEFAULT_MAX_DOCS_PER_APP,
  DEFAULT_MAX_BYTES_PER_APP,
  type DataQuotaLimits,
} from './quota.js';
export {
  enforceWriteRateLimit,
  DEFAULT_WRITE_LIMIT,
  DEFAULT_WRITE_WINDOW_MS,
} from './rate-limit.js';
export {
  defineCollection,
  getCollection,
  listCollections,
  type CollectionRow,
  type DefineCollectionInput,
  type DefineCollectionResult,
} from './collections.server.js';
export {
  resolveApp,
  resolveRestCaller,
  type ResolvedApp,
} from './resolve.server.js';
export {
  createRecord,
  readRecord,
  updateRecord,
  deleteRecord,
  queryRecords,
  type DataLocator,
  type DataRecord,
  type QueryResult,
  type RecordContext,
} from './records.server.js';
