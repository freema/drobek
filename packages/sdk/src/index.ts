/**
 * @drobek/sdk — the browser SDK core. `core.ts` is bundled
 * into `/__drobek/sdk.js` with the SDK entry of every active platform module;
 * module SDK entries type their argument with `SdkCore` from here.
 * `beacon.ts` is bundled into `/__drobek/beacon.js`, which the
 * compiler imports into every app: the page load, uncaught browser errors,
 * failed resource loads and CSP blocks → the app's beacon.
 */
export const SDK_VERSION = '1.0.0';
export {
  DrobekError,
  MODULE_API_BASE,
  SDK_HEADER,
  createCore,
  type QueryValue,
  type RequestOptions,
  type SdkCore,
} from './core.js';
export { CORE_SDK_TYPES } from './types.js';
export {
  BEACON_ENDPOINT,
  BEACON_FLUSH_MS,
  BEACON_MAX_BATCH,
  BEACON_MAX_BYTES,
  BEACON_MAX_PER_PAGE,
  BEACON_MAX_REPEATS,
  VERSION_TIMING_METRIC,
  describeError,
  describeResource,
  describeViolation,
  installBeacon,
  packBatches,
  pageVersion,
  type BeaconEnv,
  type BeaconEvent,
  type BeaconEventType,
  type BeaconHandle,
  type BeaconMeta,
} from './beacon.js';
