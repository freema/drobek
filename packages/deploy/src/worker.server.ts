/**
 * Deploy worker (U6, PHY-57 / PHY-100). Runs inside the web image as the
 * drobek-worker container. For each queued deploy it:
 *   (a) LINT   — recompute the strict no-headless-browser gate over the STORED
 *                bytes (never the client manifest); a hard error BLOCKS.
 *   (b) STORE  — materialize blob_refs + deploy_files for the deploy.
 *   (c) ACTIVATE — in ONE txn: deploy → ready AND apps.active_deploy_id flip.
 *   (d) AUDIT  — append a deploy.activate row.
 * Progress is published to redis pub/sub at each step. A per-app advisory lock
 * (redis) serializes concurrent deploys of the same app. Idempotent: a deploy
 * already `ready` is a no-op.
 */
import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import {
  createConsoleLogger,
  getRedis,
  type BlobStore,
  type Logger,
} from '@drobek/core';
import { apps, blobRefs, blobs, deployFiles, deploys, getDb } from '@drobek/db';
import { bustServeCache } from '@drobek/serving/cache';
import {
  writeAudit,
  AUDIT_ACTIONS,
  AUDIT_SUBJECT_TYPES,
  type AuditActorKind,
} from './audit.server.js';
import {
  DEPLOY_QUEUE,
  QUEUE_PREFIX,
  appLockKey,
  appUrl,
  quotaLimitsFromEnv,
} from './constants.js';
import {
  isLintable,
  lintErrorSummary,
  lintFiles,
  type LintFinding,
  type LintReport,
} from './lint.js';
import type { ManifestEntry } from './manifest.js';
import { sweepOrphanBlobs, type OrphanSweepDeps } from './orphan-sweep.js';
import { publishDeployProgress } from './progress.server.js';
import { createBullConnection } from './queue.server.js';
import {
  getBlobStore,
  loadAppRow,
  loadDeployRow,
} from './store.server.js';
import type { DeployState } from './types.js';

let logger: Logger | null = null;
function log(): Logger {
  logger ??= createConsoleLogger('drobek-deploy-worker');
  return logger;
}

/**
 * The lint gate is a SECURITY control, so it must scan the WHOLE lintable file —
 * a partial scan would let a large file hide a blocked reference past the cap.
 * `cap` is set to the per-file byte quota, which the upload sink already enforces
 * mid-stream, so every stored lintable blob fits; `truncated` can only be true if
 * a file somehow exceeds the quota, and we then hard-fail it (never silently pass).
 */
async function readBlobText(
  store: BlobStore,
  sha256: string,
  cap: number
): Promise<{ text: string; truncated: boolean } | null> {
  const stream = await store.getStream(sha256);
  if (!stream) return null;
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(Buffer.from(value));
      if (total > cap) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function lintDeploy(entries: ManifestEntry[]): Promise<LintReport> {
  const store = getBlobStore();
  const cap = quotaLimitsFromEnv().maxFileBytes;
  const files: { path: string; content: string }[] = [];
  const extraErrors: LintFinding[] = [];
  for (const e of entries) {
    if (!isLintable(e.path)) continue;
    const read = await readBlobText(store, e.sha256, cap);
    if (read === null) continue;
    if (read.truncated) {
      // A lintable file larger than the per-file quota cannot be fully scanned
      // for the headless-browser policy — reject rather than pass the unscanned tail.
      extraErrors.push({
        path: e.path,
        rule: 'unscannable-file',
        message: `exceeds the ${cap}-byte scannable limit for policy linting`,
      });
      continue;
    }
    files.push({ path: e.path, content: read.text });
  }
  const report = lintFiles(files);
  if (extraErrors.length > 0) {
    return {
      ok: false,
      errors: [...report.errors, ...extraErrors],
      warnings: report.warnings,
    };
  }
  return report;
}

async function persistDeployFiles(
  deployId: string,
  entries: ManifestEntry[]
): Promise<void> {
  const uniqueShas = [...new Set(entries.map((e) => e.sha256))];
  if (uniqueShas.length > 0) {
    await getDb()
      .insert(blobRefs)
      .values(uniqueShas.map((sha256) => ({ sha256, deployId })))
      .onConflictDoNothing();
  }
  if (entries.length > 0) {
    await getDb()
      .insert(deployFiles)
      .values(entries.map((e) => ({ deployId, path: e.path, sha256: e.sha256 })))
      .onConflictDoNothing();
  }
}

async function setState(deployId: string, state: DeployState): Promise<void> {
  await getDb().update(deploys).set({ state }).where(eq(deploys.id, deployId));
}

/**
 * Per-app advisory lock via redis SET NX PX + a compare-and-delete release.
 * A busy lock is waited on briefly then throws → BullMQ retries the job.
 */
async function acquireAppLock(
  appId: string,
  opts: { ttlMs?: number; waitMs?: number; pollMs?: number } = {}
): Promise<() => Promise<void>> {
  const { ttlMs = 30_000, waitMs = 25_000, pollMs = 200 } = opts;
  const redis = getRedis();
  const key = appLockKey(appId);
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
    if (ok === 'OK') break;
    if (Date.now() >= deadline) {
      throw new Error(`deploy lock busy for app ${appId}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return async () => {
    const lua =
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    try {
      await redis.eval(lua, 1, key, token);
    } catch {
      /* best-effort release; the PX TTL is the backstop */
    }
  };
}

export interface ProcessDeployJob {
  deployId: string;
  /** Committing actor (PHY-85), for the deploy.activate audit. */
  actorUserId?: string | null;
  actorKind?: AuditActorKind | null;
}

export async function processDeployJob(job: ProcessDeployJob): Promise<void> {
  const { deployId } = job;
  const deploy = await loadDeployRow(deployId);
  if (!deploy) {
    log().warn('deploy job for unknown deploy', { deployId });
    return;
  }
  if (deploy.state === 'ready') return; // idempotent re-run

  const app = await loadAppRow(deploy.appId);
  if (!app) {
    await getDb()
      .update(deploys)
      .set({ state: 'failed', error: 'internal: app row missing' })
      .where(eq(deploys.id, deployId));
    await publishDeployProgress({
      deployId,
      state: 'failed',
      error: 'internal error',
      terminal: true,
    });
    return;
  }

  const release = await acquireAppLock(app.id);
  try {
    const fresh = await loadDeployRow(deployId);
    if (!fresh || fresh.state === 'ready') return;
    const entries = fresh.manifest;

    // (a) LINT — SECURITY gate over stored bytes.
    await setState(deployId, 'linting');
    await publishDeployProgress({ deployId, state: 'linting', step: 'lint' });
    const report = await lintDeploy(entries);
    if (!report.ok) {
      const summary = lintErrorSummary(report);
      await getDb()
        .update(deploys)
        .set({ state: 'failed', lintReport: report, error: summary })
        .where(eq(deploys.id, deployId));
      await publishDeployProgress({
        deployId,
        state: 'failed',
        step: 'lint',
        error: summary,
        terminal: true,
      });
      log().warn('deploy blocked by lint', { deployId, summary });
      return;
    }

    // (b) STORE — refs + files.
    await setState(deployId, 'storing');
    await publishDeployProgress({ deployId, state: 'storing', step: 'store' });
    await persistDeployFiles(deployId, entries);

    // (c) ACTIVATE — atomic ready + pointer flip.
    await setState(deployId, 'activating');
    await publishDeployProgress({ deployId, state: 'activating', step: 'activate' });
    await getDb().transaction(async (tx) => {
      await tx
        .update(deploys)
        .set({ state: 'ready', lintReport: report, error: null, activatedAt: new Date() })
        .where(eq(deploys.id, deployId));
      await tx
        .update(apps)
        .set({ activeDeployId: deployId })
        .where(eq(apps.id, app.id));
    });

    // U7: the active pointer just moved — invalidate the serving cache so the
    // new version is served immediately (best-effort; TTL backstop otherwise).
    await bustServeCache({ workspaceId: app.workspaceId, appSlug: app.slug });

    // (d) AUDIT. The deploy runs async in the worker, but attribution is carried
    // on the job from the committing call site (PHY-85): the MCP deploy_commit
    // tool → agent, a (future) dashboard commit → user. actor_kind defaults to
    // 'user' at the DB only if a legacy job carries none; new jobs always thread it.
    await writeAudit({
      workspaceId: app.workspaceId,
      actorUserId: job.actorUserId ?? null,
      actorKind: job.actorKind ?? 'user',
      action: AUDIT_ACTIONS.deployActivate,
      subjectType: AUDIT_SUBJECT_TYPES.app,
      target: app.slug,
      meta: { deployId, appId: app.id },
    });

    await publishDeployProgress({
      deployId,
      state: 'ready',
      step: 'activate',
      url: appUrl(app.workspaceSlug, app.slug),
      terminal: true,
    });
    log().info('deploy activated', { deployId, app: app.slug });
  } finally {
    await release();
  }
}

/** db-backed orphan-sweep deps: metadata row + on-disk bytes deletion. */
export function dbOrphanSweepDeps(): OrphanSweepDeps {
  return {
    async listAllShas() {
      const rows = await getDb().select({ sha256: blobs.sha256 }).from(blobs);
      return rows.map((r) => r.sha256);
    },
    async listReferencedShas() {
      const rows = await getDb()
        .selectDistinct({ sha256: blobRefs.sha256 })
        .from(blobRefs);
      return new Set(rows.map((r) => r.sha256));
    },
    async deleteBlob(sha256: string) {
      await getDb().delete(blobs).where(eq(blobs.sha256, sha256));
      await getBlobStore().delete(sha256);
    },
  };
}

/** Delete every unreferenced blob (db + disk). Callable + wired to a periodic sweep. */
export async function sweepOrphanBlobsFromDb() {
  return sweepOrphanBlobs(dbOrphanSweepDeps());
}

/**
 * Construct the BullMQ Worker: queue "deploys", prefix "drobek" (shared-redis
 * isolation), connection with maxRetriesPerRequest:null. Used by the worker
 * entry (apps/web/scripts/worker.mjs).
 */
export function createDeployWorker(): Worker {
  const concurrency = Number(process.env.DEPLOY_WORKER_CONCURRENCY ?? 2) || 2;
  return new Worker(
    DEPLOY_QUEUE,
    async (job) => {
      await processDeployJob(job.data as ProcessDeployJob);
    },
    { connection: createBullConnection(), prefix: QUEUE_PREFIX, concurrency }
  );
}
