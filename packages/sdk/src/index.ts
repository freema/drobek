/**
 * @drobek/sdk — the browser SDK core (M1-01, NSO-287). `core.ts` is bundled
 * into `/__drobek/sdk.js` with the SDK entry of every active platform module;
 * module SDK entries type their argument with `SdkCore` from here.
 * `beacon.ts` (M1-07) is bundled into `/__drobek/beacon.js`, which the
 * compiler imports into every app: uncaught browser errors → the app's beacon.
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
  describeError,
  installBeacon,
  packBatches,
  type BeaconEnv,
  type BeaconEvent,
  type BeaconHandle,
} from './beacon.js';
