/**
 * knip — unused files, exports, types and dependencies across the
 * pnpm workspace. Runs in `task check` (`pnpm knip`) and in the CI quality
 * job; the gate is 0 findings.
 *
 * knip's plugins pick up most entry points on their own: vitest configs and
 * `*.test.ts`, the React Router app of `apps/server` (react-router.config.ts +
 * app/routes.ts), Playwright (tests-e2e/playwright.config.ts), package.json
 * `exports`/`bin`/`scripts` and the Taskfile. What they cannot see is listed
 * below per workspace — files loaded by path at runtime (the module SDK
 * entries esbuild bundles into /__drobek/sdk.js, CLIs run as
 * `node <pkg>/dist/cli/*.js`, scripts started from shell or compose files).
 *
 * Every ignore carries its reason. Do not add one without it.
 */
import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': {
      // The repo's own scripts: doc-lint (package.json), the manual agent
      // eval (`task eval` → node tests-eval/run.mjs, which imports lib.mjs).
      entry: ['scripts/*.mjs', 'tests-eval/*.mjs'],
      project: ['scripts/**/*.mjs', 'tests-eval/**/*.mjs'],
      ignoreBinaries: [
        // `pnpm -C tests-e2e exec playwright …` (Taskfile, ci.yml): the binary
        // belongs to the tests-e2e workspace, which lists @playwright/test.
        'playwright',
      ],
    },

    'apps/server': {
      // server/index.ts (package.json `dev`/`start`) and the routes are found
      // by the plugins; migrate.ts is `node dist/server/migrate.js`, the
      // self-host upgrade step (`task selfhost:migrate`).
      entry: ['server/migrate.ts'],
      project: ['server/**/*.ts', 'app/**/*.{ts,tsx}'],
      ignoreDependencies: [
        // The React Router SSR build bundles the linked workspace packages and
        // leaves their npm dependencies external: build/server/*.js imports
        // `nodemailer` (reached through @drobek/email), so it must resolve
        // from apps/server — i.e. be a direct dependency, although no source
        // file of this workspace imports it.
        'nodemailer',
        // Same reason: build/server/index.js imports these through
        // @drobek/db / @drobek/core.
        '@paralleldrive/cuid2',
        'drizzle-orm',
        'ioredis',
        // Same reason: @drobek/modules builds the SDK with it.
        'esbuild',
        // DROBEK_MODULES entries are resolved at runtime from the SERVER's
        // package.json (packages/modules registry.ts, createRequire): the
        // built-in modules and the example module are dependencies so the
        // image can load them; nothing imports them statically.
        /^drobek-module-/,
      ],
    },

    'packages/core': {
      // `node packages/core/dist/cli/caddy-config.js` (Taskfile tls:*,
      // scripts/selfhost-init.sh, scripts/e2e-image.sh).
      entry: ['src/cli/*.ts'],
    },

    'packages/oauth': {
      // `node …/@drobek/oauth/dist/cli/api-key-create.js` (Taskfile
      // api-key:create, README, selfhost rehearsal, tests-eval).
      entry: ['src/cli/*.ts'],
    },

    'packages/sdk': {
      // src/beacon-entry.ts is bundled by path into /__drobek/beacon.js. The
      // rest are public entry points: `exports` point at dist/, which knip
      // does not map back to the sources.
      entry: ['src/beacon-entry.ts', 'src/index.ts', 'src/core.ts', 'src/beacon.ts'],
    },

    'packages/modules': {
      // Public entry points (`.`, `./testing`, `./lock`): `exports` point at
      // dist/, which knip does not map back to the sources. src/cli/module-lock.ts
      // is run by path from scripts/selfhost-module.sh.
      entry: ['src/index.ts', 'src/testing.ts', 'src/lock.ts', 'src/cli/*.ts'],
      // test-fixtures/ holds an external module package that tests copy into a
      // temporary DROBEK_MODULES_DIR by path; never imported.
      ignore: ['test-fixtures/**'],
    },

    'packages/compile': {
      // src/typecheck/worker.ts: started by path as a worker thread
      // (runner.ts, dist/typecheck/worker.js), never imported for its values.
      entry: ['src/typecheck/worker.ts'],
      ignoreDependencies: [
        // The type check resolves these by path (check.ts
        // reactTypes) and maps an app's `react` / `react-dom` imports to
        // their declarations; nothing imports them.
        '@types/react',
        '@types/react-dom',
      ],
    },

    'packages/create-drobek-module': {
      // `bin` / `exports` point at dist/ (published to npm).
      entry: ['src/index.ts', 'src/cli.ts'],
      // template/ is the scaffold's OUTPUT (a module with its own
      // package.json and tests), copied with placeholders — never imported
      // or run here; src/scaffold.test.ts generates and tests it.
      ignore: ['template/**'],
      ignoreDependencies: [
        // Linked into the generated module's node_modules by
        // src/scaffold.test.ts (the template's own dev dependencies — the
        // test installs offline from this workspace); no file here imports them.
        '@electric-sql/pglite',
        'drizzle-orm',
        'zod',
      ],
    },

    'packages/skills-check': {
      ignoreDependencies: [
        // The skill code examples are typechecked as VIRTUAL files placed in
        // this package so their `react` / `react-dom` imports resolve these
        // type packages (src/examples.ts); no real file imports them.
        '@types/react',
        '@types/react-dom',
      ],
    },

    'modules/*': {
      // `sdk.entry` (src/sdk.ts → dist/sdk.js) is bundled by path into
      // /__drobek/sdk.js; src/index.ts references it by URL, never imports it.
      entry: ['src/sdk.ts'],
    },
    'modules/auth': {
      // + `sdk.inline.entry` (sdk/auth.tsx): compiled into the app that
      // imports `drobek/auth`, referenced by path from src/index.ts.
      entry: ['src/sdk.ts', 'sdk/*.tsx'],
    },
    'modules/forms': {
      // + `sdk.inline.entry` (sdk/forms.tsx), as for modules/auth.
      entry: ['src/sdk.ts', 'sdk/*.tsx'],
    },
    'modules/sync': {
      // No browser SDK: the module only runs a scheduled job on the server.
      entry: [],
    },
    'modules/oidc': {
      // No browser SDK: the module only contributes auth's sign-in provider.
      entry: [],
    },

    'examples/*': {
      // Same contract as modules/*: the SDK entry is loaded by path; `exports`
      // point at dist/, so src/index.ts is listed as the public entry.
      entry: ['src/index.ts', 'src/sdk.ts'],
    },

    'tests-e2e': {
      // Started by path, not imported: proxy-echo.mjs by docker-compose*.y*ml
      // (`node tests-e2e/proxy-echo.mjs`), selfhost-rehearsal.mjs by
      // scripts/selfhost-rehearsal.sh.
      entry: ['proxy-echo.mjs', 'selfhost-rehearsal.mjs'],
    },
  },

  ignoreIssues: {
    // Type-check shims standing in for the server-generated `drobek` module:
    // they mirror its real shape, which exports the SDK object both as the
    // named `drobek` and as the default export.
    'modules/*/sdk/drobek.d.ts': ['duplicates'],
  },
};

export default config;
