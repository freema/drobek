/**
 * @drobek/insights — the observe slice of the agent loop, as
 * a react-free workspace LIBRARY. It closes the write→observe→fix loop inside
 * the editor agent:
 *
 *  - a PUBLIC error beacon (recordBeacon / handleBeacon) that ingests untrusted
 *    uncaught errors, unhandled rejections, failed resource loads and CSP
 *    blocks, size-capped + rate-limited + PII/secret-sanitized +
 *    ring-buffer-retained, each with the version its page was served from,
 *    and counts page loads per version — at `POST /__drobek/v1/_beacon` on
 *    every app host (@drobek/serving routes it),
 *  - cheap serving signals (incrementServingSignal) tallied on the serving
 *    path — request volume / 5xx / 404-by-path,
 *  - read models (queryAppErrors / queryAppLogs) for the dashboard Overview
 *    panels, and the get_logs side: the compile history
 *    (recordCompile), module request counters (recordModuleRequest — Redis,
 *    flushed lazily into Postgres), the
 *    three get_logs kinds (queryRuntimeLog / queryCompileLog / queryRequestLog)
 *    and the periodic retention prune (startLogsPrune),
 *  - app traffic analytics (recordPageView on the serving path, the hourly
 *    rollup + prune startTrafficRollup, the read queryTraffic): page views,
 *    a daily unique-visitor estimate, bots, top paths and referrer hosts.
 *
 * Depends only on @drobek/auth (rate-limit + client IP), @drobek/core (Redis)
 * and @drobek/db so @drobek/serving can import the signal hook with no cycle.
 */
export {
  InsightsError,
  insightsErrorStatus,
  type InsightsErrorCode,
} from './errors.js';
export {
  BEACON_MAX_BYTES,
  DEFAULT_BEACON_APP_RATE_LIMIT,
  DEFAULT_BEACON_RATE_LIMIT,
  DEFAULT_BEACON_WINDOW_MS,
  DEFAULT_MAX_EVENTS_PER_APP,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SAMPLE_RATE,
  COMPILE_HISTORY_KEEP,
  LOGS_RETENTION_DAYS,
  beaconLimitsFromEnv,
  beaconSizeVerdict,
  extractBatch,
  extractEvents,
  shouldSample,
  type BeaconBatch,
  type BeaconLimits,
} from './limits.js';
export {
  BEACON_EVENT_TYPES,
  MAX_EVENTS_PER_BATCH,
  MAX_MESSAGE,
  MAX_STACK,
  MAX_UA,
  MAX_URL,
  dedupKey,
  fileHintFromStack,
  redact,
  sanitizeEvent,
  sanitizeVersion,
  type BeaconEventType,
  type SanitizedEvent,
} from './sanitize.js';
export {
  TOP_404_LIMIT,
  dedupErrors,
  shapeLogs,
  type AppErrorsView,
  type AppLogsView,
  type DedupedError,
  type VersionRow,
  type ErrorRow,
  type RecentVersion,
  type Top404,
} from './shape.js';
export { resolveLiveApp, type ResolvedApp } from './resolve.server.js';
export {
  flushDay,
  incrementServingSignal,
  utcDay,
  type ServingSignalKind,
} from './signals.server.js';
export {
  pruneAppErrors,
  recordBeacon,
  type RecordBeaconInput,
  type RecordBeaconResult,
} from './beacon.server.js';
export {
  queryAppErrors,
  queryAppErrorsByLocator,
  queryAppLogs,
  queryAppLogsByLocator,
  type InsightsLocator,
} from './query.server.js';
export {
  BEACON_PATH,
  beaconSameOrigin,
  handleBeacon,
  type BeaconOptions,
  type BeaconRecorder,
  type BeaconRequest,
  type BeaconResponse,
} from './rest.server.js';
export {
  COMPILE_ERRORS_KEEP,
  COMPILE_LOG_LIMIT,
  LOG_ENTRIES_MAX,
  LOG_KINDS,
  STATUS_CLASSES,
  capCompileErrors,
  compileEntries,
  daysBetween,
  requestEntries,
  runtimeEntries,
  stackHead,
  statusClass,
  type CompileEntry,
  type CompileRow,
  type DailyRow,
  type FailingPath,
  type LogKind,
  type ModuleCounts,
  type ModuleStatRow,
  type RenderCounts,
  type RequestsEntry,
  type RuntimeEntry,
  type StatusClass,
  type StoredCompileError,
} from './logs.js';
export {
  logsWindowStart,
  queryCompileLog,
  queryRenderCounts,
  queryRequestLog,
  queryRuntimeLog,
  recordCompile,
  type RecordCompileInput,
  type RequestLogOptions,
} from './logs.server.js';
export {
  pruneLogs,
  startLogsPrune,
  type LogsPruneLease,
  type LogsPruneResult,
} from './prune.server.js';
export {
  flushModuleRequests,
  memoryModuleStatsRedis,
  recordModuleRequest,
  type ModuleStatsOptions,
  type ModuleStatsRedis,
} from './module-stats.server.js';
export { recordModuleJobFailure, type ModuleJobFailure } from './module-jobs.server.js';
export {
  DEFAULT_ANALYTICS_RETENTION_DAYS,
  TRAFFIC_OTHER,
  TRAFFIC_RANGES,
  TRAFFIC_TOP_KEYS_MAX,
  TRAFFIC_TOP_LIMIT,
  analyticsEnabled,
  analyticsRetentionDays,
  clampTrafficDays,
  classifyPageView,
  isBotUserAgent,
  referrerHost,
  type PageViewClass,
  type PageViewInput,
  type TrafficDay,
  type TrafficTopPath,
  type TrafficTopReferrer,
  type TrafficView,
} from './traffic.js';
export {
  memoryTrafficRedis,
  queryTraffic,
  recordPageView,
  rollupTraffic,
  startTrafficRollup,
  type QueryTrafficOptions,
  type TrafficRedis,
} from './traffic.server.js';
