import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [reactRouter()],
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
