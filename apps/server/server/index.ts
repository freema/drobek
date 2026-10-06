/**
 * drobek server entry — the ONE process of the self-hostable image.
 *
 * Boot order: refuse insecure secrets (a malformed DROBEK_MASTER_KEY_PREVIOUS
 * included), an invalid APPS_DOMAIN, TRUST_PROXY, TLS_ASK_TOKEN, LIMITS_PROVIDER_URL, DOMAINS_*,
 * APP_FRAME_SRC_EXTRA, GALLERY_FRAME_ANCESTORS, PUBLISH_APPROVAL / OPERATOR_EMAIL / PUBLISH_NOTIFY, e-mail transport
 * (EMAIL_TRANSPORT / RESEND_API_KEY / SMTP_HOST), ERROR_REPORTER_* or DB_* → apply core migrations
 * (under the migration lock; a database ahead of this image stops the start) →
 * check the keys of the stored secrets (a secret no key of this server opens
 * stops a production start) → load the platform modules (DROBEK_MODULES: the e-mail transport and error
 * reporter they contribute, their migrations, the composed SDK, the skills —
 * a bad module stops the start; once the reporter is up, the failure is
 * reported too) →
 * install the TypeScript check runner → mount the app-host dispatcher, then React Router (Vite middleware in
 * dev, `build/server` in production) behind the MCP resource → start
 * background jobs + the serve-cache subscriber → listen.
 *
 * SIGTERM / SIGINT stop it gracefully with exit code 0; an error nothing
 * caught (uncaughtException, unhandledRejection) is logged, reported and
 * stops it the same way with exit code 1.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { createRequestHandler } from '@react-router/express';
import type { RequestHandler } from 'express';
import type { ServerBuild } from 'react-router';
import { docsUrlConfigError, errorHint } from '@drobek/agent-dx';
import { appsOriginConfigError, assetLimitsOf, createAssetUploadHandler, previewUrl, publishApprovalConfigError } from '@drobek/apps';
import { trustProxyConfigError } from '@drobek/auth';
import {
  closeGracefully,
  createConsoleLogger,
  errorReporterConfigError,
  installFatalErrorHandlers,
  reportError,
  secretsConfigError,
  shutdownGraceMs,
} from '@drobek/core';
import { TypecheckRunner, installTypecheckRunner, typecheckLimitsFromEnv } from '@drobek/compile/typecheck';
import { dbConfigError, dbErrorForLog, runCoreMigrations } from '@drobek/db';
import { dnsMockWarning, domainsConfigError } from '@drobek/domains';
import { emailConfigError } from '@drobek/email';
import { endModuleStreams, limitsProviderConfigError, moduleRuntime, previousMasterKeyConfigError, storedSecretKeysCheck } from '@drobek/modules';
import {
  ServeStore,
  createAppsHostMiddleware,
  frameSrcConfigError,
  galleryFrameAncestorsConfigError,
  subscribeServeCache,
  tlsAskConfigError,
} from '@drobek/serving';
import { createServerApp } from './app.js';
import { startBackgroundJobs } from './jobs.js';
import { withSafeRouteErrors } from './route-errors.js';
import { withPublicActionOrigin } from './action-origins.js';

const log = createConsoleLogger('drobek');

const configError =
  secretsConfigError(process.env) ??
  previousMasterKeyConfigError(process.env) ??
  appsOriginConfigError(process.env) ??
  trustProxyConfigError(process.env) ??
  tlsAskConfigError(process.env) ??
  limitsProviderConfigError(process.env) ??
  domainsConfigError(process.env) ??
  frameSrcConfigError(process.env) ??
  galleryFrameAncestorsConfigError(process.env) ??
  publishApprovalConfigError(process.env) ??
  docsUrlConfigError(process.env) ??
  emailConfigError(process.env) ??
  errorReporterConfigError(process.env) ??
  dbConfigError(process.env);
if (configError) {
  console.error(configError);
  process.exit(1);
}

// Installed before anything starts: until the server listens there is nothing to drain.
let stopServer: ((reason: string) => Promise<void>) | null = null;
installFatalErrorHandlers({ log, stop: async (reason) => stopServer?.(reason), graceMs: shutdownGraceMs(process.env) });

// server/ (dev, tsx) and dist/server/ (prod) both resolve the app root.
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, basename(dirname(here)) === 'dist' ? '../..' : '..');
const production = process.env.NODE_ENV === 'production';
const dnsMock = dnsMockWarning(process.env);
if (dnsMock) log.warn(dnsMock);

if (process.env.DROBEK_MIGRATE_ON_START !== '0') {
  log.info('applying core migrations');
  await runCoreMigrations({ log }).catch(async (err: unknown) => {
    console.error(dbErrorForLog(err));
    await reportError({ level: 'fatal', message: 'the server could not start', error: err, context: { kind: 'startup' } });
    process.exit(1);
  });
}

const secretKeys = await storedSecretKeysCheck(process.env).catch((err: unknown) => {
  log.warn('could not check the keys of the stored secrets', { error: dbErrorForLog(err) });
  return null;
});
if (secretKeys?.level === 'fatal') {
  console.error(secretKeys.message);
  process.exit(1);
}
if (secretKeys) log[secretKeys.level](secretKeys.message);

// The platform modules. Loaded once per process (moduleRuntime() is
// shared with the Vite-loaded dashboard routes through globalThis).
const modules = await moduleRuntime({ log: createConsoleLogger('modules') }).catch(async (err: unknown) => {
  console.error(dbErrorForLog(err));
  await reportError({ level: 'fatal', message: 'the server could not start', error: err, context: { kind: 'startup' } });
  process.exit(1);
});

// The background TypeScript check of app versions, against this server's SDK declarations.
const typecheck = new TypecheckRunner({
  limits: typecheckLimitsFromEnv(process.env),
  sdk: { dts: modules.sdk.dts, inline: modules.sdk.inlineTypes },
  log: createConsoleLogger('typecheck'),
});
installTypecheckRunner(typecheck);

// Created up front so Vite's HMR websocket can share the app port in dev
// (a separate HMR port would not be published from the container).
const httpServer = createServer();
// Above Caddy's 2 min upstream keep-alive, so the proxy never reuses a socket Node is closing.
httpServer.keepAliveTimeout = 125_000;
httpServer.headersTimeout = 126_000;

let rrHandler: RequestHandler;
const before: RequestHandler[] = [];
let clientDir: string | undefined;
// Dev: Vite's HMR WebSockets are upgraded sockets, which hold a server drain until its grace runs out.
let closeDevServer = async (): Promise<void> => {};

if (production) {
  const buildPath = resolve(appRoot, 'build/server/index.js');
  const build = (await import(buildPath)) as ServerBuild;
  rrHandler = createRequestHandler({ build: withPublicActionOrigin(withSafeRouteErrors(build)), mode: 'production' });
  clientDir = resolve(appRoot, 'build/client');
} else {
  const vite = await import('vite');
  const devServer = await vite.createServer({
    root: appRoot,
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });
  before.push(devServer.middlewares);
  closeDevServer = () => devServer.close();
  rrHandler = createRequestHandler({
    build: async () =>
      withPublicActionOrigin(
        withSafeRouteErrors((await devServer.ssrLoadModule('virtual:react-router/server-build')) as ServerBuild)
      ),
    mode: 'development',
  });
}

// The app hosts' cache, busted by every app-changed event (in-process
// and over Redis pub/sub).
const serveStore = new ServeStore();
const serveCache = subscribeServeCache(serveStore, { log });
const appsHost = createAppsHostMiddleware({
  store: serveStore,
  // `/__drobek/*` on the app hosts: the SDK + module routes.
  deps: { platform: (req, { app }) => modules.handle(req, app) },
}) as RequestHandler;

// The asset upload URLs (create_asset_upload / the Assets tab).
const assetUpload = createAssetUploadHandler({
  limits: async (workspaceId) => assetLimitsOf(await modules.workspaceLimits(workspaceId)),
  hint: errorHint,
  assetUrl: (slug, path) => `${previewUrl(slug)}${path}`,
  log: createConsoleLogger('assets'),
}) as RequestHandler;

const app = createServerApp({ rrHandler, before, clientDir, appsHost, assetUpload });
const jobs = startBackgroundJobs(log, { filesSweep: modules.modules.some((m) => m.name === 'files'), modules });

httpServer.on('request', app);
const port = Number(process.env.PORT ?? 3000);
httpServer.listen(port, '0.0.0.0', () => {
  log.info('drobek listening', { port, mode: production ? 'production' : 'development' });
});

let stopping: Promise<void> | null = null;
/** The graceful stop, once: end the long-lived streams, drain the requests in flight, then close the sessions, jobs and caches. Does not exit. */
function stop(reason: string): Promise<void> {
  stopping ??= (async () => {
    const graceMs = shutdownGraceMs(process.env);
    log.info('shutting down', { reason, grace_ms: graceMs });
    app.mcp.endListenStreams();
    endModuleStreams();
    await closeDevServer();
    const { drained } = await closeGracefully(httpServer, { graceMs });
    if (!drained) log.warn('requests still running after the shutdown grace period were cut', { grace_ms: graceMs });
    await app.mcp.closeSessions();
    await jobs.stop();
    await serveCache.stop();
    await typecheck.close();
  })();
  return stopping;
}

function stopOnSignal(signal: NodeJS.Signals): void {
  void stop(signal).then(
    () => process.exit(),
    (err: unknown) => {
      log.error('the server did not stop cleanly', { error: dbErrorForLog(err, { stack: true }) });
      process.exit(1);
    }
  );
}
stopServer = stop;
process.on('SIGTERM', () => stopOnSignal('SIGTERM'));
process.on('SIGINT', () => stopOnSignal('SIGINT'));
