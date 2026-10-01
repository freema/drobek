/**
 * The `.` entry of the npm package `@freema/drobek-modules`
 * (scripts/npm-packages.mjs): the public contract, plus two test helpers
 * that modules written before `@drobek/modules/testing` offered them still
 * import from here.
 */
import { buildSdk as testingBuildSdk, loadModules as testingLoadModules } from './testing.js';

export * from './public.js';

/** @deprecated Import `loadModules` from `@drobek/modules/testing`; this re-export goes away in the next major version. */
export const loadModules: typeof testingLoadModules = testingLoadModules;

/** @deprecated Import `buildSdk` from `@drobek/modules/testing`; this re-export goes away in the next major version. */
export const buildSdk: typeof testingBuildSdk = testingBuildSdk;
