import {
  abuseReportsRetentionDays,
  pruneGalleryOpens,
  pruneResolvedAbuseReports,
  startAssetsSweep,
  startBlobGc,
  startSlugRelease,
  withRedisLock,
} from '@drobek/apps';
import { auditRetentionDays, pruneAuditLog } from '@drobek/audit';
import type { Logger } from '@drobek/core';
import { startDomainRecheck } from '@drobek/domains';
import { startLogsPrune } from '@drobek/insights';
import { startModuleJobs, type ModuleRuntime } from '@drobek/modules';
import { pruneExpiredOAuth } from '@drobek/oauth';
import { startFilesSweep } from 'drobek-module-files';
import { dbErrorForLog } from '@drobek/db';

const DAILY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_LOCK_KEY = 'drobek:lock:retention-prune';
const RETENTION_LOCK_TTL_SEC = 15 * 60;

export interface BackgroundJobs {
  stop(): Promise<void>;
}

/**
 * In-process background work — there is no separate worker container.
 *
 * - Blob GC (hourly, one replica at a time via a Redis lease): deletes blobs
 *   no version references, after a 7-day grace period.
 * - Slug release (hourly, Redis lease): a soft-deleted app's slug is
 *   free again 30 days after the delete (renamed to its tombstone).
 * - Custom domains: the DNS re-check (hourly sweep, Redis lease) of every
 *   verified domain last checked 24 h+ ago — records gone → unverified + one
 *   e-mail to the app's owners.
 * - Files sweep (only when the `files` module is active;
 *   FILES_SWEEP_INTERVAL_MS, Redis lease): the uploads of apps deleted
 *   FILES_SWEEP_RETENTION_MS ago, blobs no `mod_files` row references and
 *   stale temp uploads (logic in drobek-module-files).
 * - get_logs retention prune (LOGS_PRUNE_INTERVAL_MS, Redis lease):
 *   browser errors, compiles and daily request stats older than their
 *   retention (30 days) and errors past the newest 500 per app, for every app
 *   (logic in @drobek/insights).
 * - Assets sweep (hourly, Redis lease): the asset files of apps
 *   deleted 24 h+ ago, stale temp uploads and files no `app_assets` row
 *   references (logic in @drobek/apps).
 * - Module jobs (only when an active module declares `jobs`;
 *   MODULE_JOBS_ENABLED / _CONCURRENCY / _TIMEOUT_MS, a Redis lease per run):
 *   the modules' scheduled work, per server or per app (logic in
 *   @drobek/modules jobs.ts). Nothing runs before the first tick.
 * - Retention prune (startup, then daily, Redis lease): OAuth access and
 *   refresh tokens 7 days past their expiry and authorization codes once the
 *   lineage they minted is gone (@drobek/oauth), gallery open counts older
 *   than the 30-day window plus 7 days and abuse reports resolved
 *   ABUSE_REPORTS_RETENTION_DAYS ago (@drobek/apps).
 * - Governance: the audit trail is append-only; the ONLY deletion is
 *   the age-based retention prune (startup, then daily). It never targets a
 *   specific row and is not exposed over any API/UI.
 */
export function startBackgroundJobs(log: Logger, opts: { filesSweep?: boolean; modules?: ModuleRuntime } = {}): BackgroundJobs {
  // The jobs hand over an already log-safe error text (dbErrorForLog at the source).
  const jobLog = (msg: string, errorText?: string) => (errorText ? log.error(msg, { error: errorText }) : log.info(msg));
  const stopBlobGc = startBlobGc(jobLog);
  const stopSlugRelease = startSlugRelease(jobLog);
  const stopFilesSweep = opts.filesSweep ? startFilesSweep({ log: jobLog, lease: withRedisLock }) : () => {};
  const stopLogsPrune = startLogsPrune({ log: jobLog, lease: withRedisLock });
  const stopAssetsSweep = startAssetsSweep({ log: jobLog });
  const stopModuleJobs = opts.modules ? startModuleJobs({ runtime: opts.modules, lease: withRedisLock, log }) : async () => {};

  const stopDomainRecheck = startDomainRecheck((msg, meta, errorText) =>
    errorText ? log.error(msg, { ...meta, error: errorText }) : log.info(msg, meta)
  );

  const pruneAuditOnce = async (): Promise<void> => {
    try {
      const { deleted } = await pruneAuditLog();
      if (deleted > 0) {
        log.info('audit retention prune', { deleted, retentionDays: auditRetentionDays() });
      }
    } catch (err) {
      log.error('audit retention prune failed', { error: dbErrorForLog(err) });
    }
  };
  const pruneRetentionOnce = async (): Promise<void> => {
    try {
      const out = await withRedisLock(RETENTION_LOCK_KEY, RETENTION_LOCK_TTL_SEC, async () => ({
        oauth: await pruneExpiredOAuth(),
        galleryOpens: await pruneGalleryOpens(),
        abuseReports: await pruneResolvedAbuseReports(),
      }));
      if (!out.acquired) return;
      const { oauth, galleryOpens, abuseReports } = out.result;
      if (oauth.accessTokens + oauth.refreshTokens + oauth.authorizationCodes + galleryOpens.deleted + abuseReports.deleted > 0) {
        log.info('retention prune', {
          oauthAccessTokens: oauth.accessTokens,
          oauthRefreshTokens: oauth.refreshTokens,
          oauthAuthorizationCodes: oauth.authorizationCodes,
          galleryOpenDays: galleryOpens.deleted,
          abuseReports: abuseReports.deleted,
          abuseReportsRetentionDays: abuseReportsRetentionDays(),
        });
      }
    } catch (err) {
      log.error('retention prune failed', { error: dbErrorForLog(err) });
    }
  };
  const pruneDaily = () => {
    void pruneAuditOnce();
    void pruneRetentionOnce();
  };
  pruneDaily();
  const timer = setInterval(pruneDaily, DAILY_PRUNE_INTERVAL_MS);
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      stopBlobGc();
      stopSlugRelease();
      stopFilesSweep();
      stopLogsPrune();
      stopAssetsSweep();
      stopDomainRecheck();
      await stopModuleJobs();
    },
  };
}
