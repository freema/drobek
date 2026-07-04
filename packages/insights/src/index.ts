/**
 * @drobek/insights — the agent-loop v1 (PHY-123, the observe slice of PHY-92) as
 * a react-free workspace LIBRARY. It closes the deploy→observe→fix loop inside
 * the editor agent:
 *
 *  - a PUBLIC error beacon (recordBeacon / handleBeacon) that ingests untrusted
 *    window.onerror + unhandledrejection events, size-capped + rate-limited +
 *    PII/secret-sanitized + ring-buffer-retained,
 *  - cheap serving signals (incrementServingSignal) tallied on the U7 serving
 *    path — request volume / 5xx / 404-by-path,
 *  - read models (queryAppErrors / queryAppLogs) surfaced to the agent via the
 *    app_errors + app_logs MCP tools and to the dashboard Overview panels.
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
  beaconLimitsFromEnv,
  beaconSizeVerdict,
  extractEvents,
  shouldSample,
  type BeaconLimits,
} from './limits.js';
export {
  MAX_EVENTS_PER_BATCH,
  MAX_MESSAGE,
  MAX_STACK,
  MAX_UA,
  MAX_URL,
  dedupKey,
  fileHintFromStack,
  redact,
  sanitizeEvent,
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
  type DeployRow,
  type ErrorRow,
  type RecentDeploy,
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
export { handleBeacon, type BeaconParams } from './rest.server.js';
