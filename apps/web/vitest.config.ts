import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Separate from vite.config.ts on purpose: the React Router plugin must not
// load inside Vitest.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, 'app'),
    },
  },
});
