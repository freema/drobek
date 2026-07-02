/**
 * Kept as a literal (not read from package.json at runtime): the web app's
 * Vite SSR build inlines workspace packages, where `createRequire`-style
 * relative package.json lookups break. `version.test.ts` guards the literal
 * against drift from packages/core/package.json.
 */
export const CORE_VERSION = '0.1.0';

export type CoreVersion = {
  name: string;
  version: string;
  sha: string;
};

/** Core package version + the git sha baked into the running image. */
export function coreVersion(): CoreVersion {
  return {
    name: '@drobek/core',
    version: CORE_VERSION,
    sha: process.env.GIT_SHA || 'dev',
  };
}
