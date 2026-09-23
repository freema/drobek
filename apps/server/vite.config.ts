import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [reactRouter()],
  optimizeDeps: {
    // Server-only deps reached through @drobek/core / @drobek/db. React
    // Router's dev-time route/manifest crawl registers them with the CLIENT
    // dep optimizer lazily — on a cold cache (compose up -V) that fires
    // "✨ new dependencies optimized … reloading" mid-session, and the forced
    // full page reload races (and can wipe out) an in-flight client
    // navigation (flaked the U2 auth e2e). Pre-bundling them here makes the
    // optimizer state deterministic at startup; the browser never actually
    // executes them.
    include: [
      'ioredis',
      'postgres',
      'drizzle-orm',
      'drizzle-orm/pg-core',
      'drizzle-orm/postgres-js',
      '@paralleldrive/cuid2',
    ],
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
