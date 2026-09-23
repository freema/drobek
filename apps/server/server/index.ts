/**
 * drobek server entry — the ONE process of the self-hostable image (M0-01).
 *
 * Boot order: refuse insecure secrets (PHY-76 #6), an invalid APPS_DOMAIN,
 * TRUST_PROXY or TLS_ASK_TOKEN → apply core migrations →
 * mount the app-host dispatcher (M0-06), then React Router (Vite middleware in
 * dev, `build/server` in production) behind the MCP resource → start
 * background jobs + the serve-cache subscriber → listen.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { createRequestHandler } from '@react-router/express';
import type { RequestHandler } from 'express';
import type { ServerBuild } from 'react-router';
import { appsOriginConfigError } from '@drobek/apps';
import { trustProxyConfigError } from '@drobek/auth';
import { createConsoleLogger, secretsConfigError } from '@drobek/core';
import { runCoreMigrations } from '@drobek/db';
import {
  ServeStore,
  createAppsHostMiddleware,
  subscribeServeCache,
  tlsAskConfigError,
} from '@drobek/serving';
import { createServerApp } from './app.js';
import { startBackgroundJobs } from './jobs.js';

const log = createConsoleLogger('drobek');

const configError =
  secretsConfigError(process.env) ??
  appsOriginConfigError(process.env) ??
  trustProxyConfigError(process.env) ??
  tlsAskConfigError(process.env);
if (configError) {
  console.error(configError);
  process.exit(1);
}

// server/ (dev, tsx) and dist/server/ (prod) both resolve the app root.
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, basename(dirname(here)) === 'dist' ? '../..' : '..');
const production = process.env.NODE_ENV === 'production';

if (process.env.DROBEK_MIGRATE_ON_START !== '0') {
  log.info('applying core migrations');
  await runCoreMigrations();
}

// Created up front so Vite's HMR websocket can share the app port in dev
// (a separate HMR port would not be published from the container).
const httpServer = createServer();

let rrHandler: RequestHandler;
const before: RequestHandler[] = [];
let clientDir: string | undefined;

if (production) {
  const buildPath = resolve(appRoot, 'build/server/index.js');
  const build = (await import(buildPath)) as ServerBuild;
  rrHandler = createRequestHandler({ build, mode: 'production' });
  clientDir = resolve(appRoot, 'build/client');
} else {
  const vite = await import('vite');
  const devServer = await vite.createServer({
    root: appRoot,
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });
  before.push(devServer.middlewares);
  rrHandler = createRequestHandler({
    build: () =>
      devServer.ssrLoadModule('virtual:react-router/server-build') as Promise<ServerBuild>,
    mode: 'development',
  });
}

// M0-06: the app hosts' cache, busted by every app-changed event (in-process
// and over Redis pub/sub).
const serveStore = new ServeStore();
const serveCache = subscribeServeCache(serveStore, { log });
const appsHost = createAppsHostMiddleware({ store: serveStore }) as RequestHandler;

const app = createServerApp({ rrHandler, before, clientDir, appsHost });
const jobs = startBackgroundJobs(log);

httpServer.on('request', app);
const port = Number(process.env.PORT ?? 3000);
const server = httpServer.listen(port, '0.0.0.0', () => {
  log.info('drobek listening', { port, mode: production ? 'production' : 'development' });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  server.close();
  await jobs.stop();
  await serveCache.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
