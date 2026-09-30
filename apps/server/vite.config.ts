import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [reactRouter()],
  optimizeDeps: {
    // Explicit optimizer: pre-bundle only `include` (+ react, react-dom,
    // react-router from the plugin). Discovery made dev SSR register
    // server-only workspace deps with the client optimizer, and on a cold
    // cache the re-optimization's full reload wiped an in-flight sign-in.
    // A new browser-side npm dependency goes into `include` (guarded by
    // server/vite-config.test.ts).
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
