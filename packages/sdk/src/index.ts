/**
 * @drobek/sdk — the browser SDK core (M1-01, NSO-287). `core.ts` is bundled
 * into `/__drobek/sdk.js` with the SDK entry of every active platform module;
 * module SDK entries type their argument with `SdkCore` from here.
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
