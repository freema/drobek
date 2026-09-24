import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [reactRouter()],
  optimizeDeps: {
    // NSO-314: the client dep optimizer never DISCOVERS deps at runtime; it
    // pre-bundles exactly the `include` list, which the React Router plugin
    // fills with react, react-dom and react-router — the only npm packages
    // the browser loads (every other client import is a workspace package;
    // server/vite-config.test.ts guards that). With discovery on, React
    // Router's dev SSR render collects each matched route's CSS by walking
    // its SSR module graph and looking the deps up in the client module graph
    // (`getModuleByUrl`), which resolves server-only imports of the workspace
    // packages (drizzle, ioredis, …) in the client environment and registers
    // them as "new dependencies". On a cold cache (a lockfile change,
    // `compose up -V`) that re-ran the optimizer after the first page was
    // served and forced a full page reload that wiped an in-flight sign-in
    // (the first-login e2e flake). The hand-kept list of those server deps
    // that used to live here had gone stale (drizzle-orm/postgres-js/migrator);
    // an explicit optimizer cannot. A new browser-side npm dependency goes
    // into `include` below (a CJS one fails in dev otherwise).
    noDiscovery: true,
    include: [],
  },
  server: {
    host: true,
    allowedHosts: true,
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, 'app'),
    },
    dedupe: ['react', 'react-dom'],
  },
});
