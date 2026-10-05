/**
 * Keeping a version: a member marks a version (`app_versions.kept_at`) so
 * neither the history retention nor a clean-up deletes it
 * (version-retention.server.ts). An app keeps at most APP_VERSIONS_KEPT_MAX
 * versions; a lower cap later leaves the versions already kept alone and only
 * refuses keeping more. Keeping works on a taken-down app (it only protects
 * history) and on a version whose build failed.
 */
import { and, count, desc, eq, isNotNull } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { appVersions, getDb } from '@drobek/db';
import { AppsError } from './errors.js';
import { missingVersionMessage, versionProtections, versionStorageLimits } from './version-retention.server.js';
import { lockApp } from './versions.server.js';
import type { Actor } from './types.js';

export interface KeepVersionOptions {
  /** APP_VERSIONS_KEPT_MAX of the app's workspace (versionStorageLimitsOf); default: the env. */
  keptMax?: number;
  /** APP_VERSIONS_KEEP of the app's workspace; default: the env. */
  keep?: number;
}

export interface KeepVersionResult {
  number: number;
  kept: boolean;
  keptAt: Date | null;
  /** False when the version already was in the asked state (nothing changed, nothing audited). */
  changed: boolean;
  /**
   * After an unkeep: true when the version is outside the app's newest
   * APP_VERSIONS_KEEP and nothing else protects it — the next retention run
   * deletes it.
   */
  prunable: boolean;
}

/**
 * Keep (`kept: true`) or stop keeping version `number` of the app, under the
 * app's row lock. Refuses with `not_found` for a version that does not exist
 * (saying whether it was deleted) and with `limit_exceeded` (details
 * `{ limit: 'APP_VERSIONS_KEPT_MAX', value }`) when the app already keeps
 * `keptMax` versions. Audited `app.version.keep` / `app.version.unkeep`.
 */
export async function keepVersion(
  appId: string,
  number: number,
  kept: boolean,
  actor: Actor,
  opts: KeepVersionOptions = {}
): Promise<KeepVersionResult> {
  const env = versionStorageLimits();
  const keptMax = opts.keptMax ?? env.keptMax;
  const keep = opts.keep ?? env.keep;
  return getDb().transaction(async (tx) => {
    const app = await lockApp(tx, appId);
    const [version] = await tx
      .select({ id: appVersions.id, keptAt: appVersions.keptAt })
      .from(appVersions)
      .where(and(eq(appVersions.appId, appId), eq(appVersions.number, number)));
    if (!version) throw new AppsError('not_found', await missingVersionMessage(appId, number, { keep, ex: tx }));

    const prunableAfter = async (): Promise<boolean> => {
      if (kept) return false;
      const [newest] = await tx
        .select({ n: appVersions.number })
        .from(appVersions)
        .where(eq(appVersions.appId, appId))
        .orderBy(desc(appVersions.number))
        .limit(1);
      if (!newest || number > newest.n - keep) return false;
      const reason = (await versionProtections(appId, [number], tx)).get(number) ?? null;
      return reason === null || reason === 'recent';
    };

    if ((version.keptAt !== null) === kept) {
      return { number, kept, keptAt: version.keptAt, changed: false, prunable: await prunableAfter() };
    }
    if (kept) {
      const [row] = await tx
        .select({ n: count() })
        .from(appVersions)
        .where(and(eq(appVersions.appId, appId), isNotNull(appVersions.keptAt)));
      const already = Number(row?.n ?? 0);
      if (already >= keptMax) {
        throw new AppsError(
          'limit_exceeded',
          `This app already keeps ${already} versions; the limit (APP_VERSIONS_KEPT_MAX) is ${keptMax} — version ${number} was not kept. Stop keeping a version the app no longer needs first, or ask the operator for a higher limit.`,
          { details: { limit: 'APP_VERSIONS_KEPT_MAX', value: keptMax } }
        );
      }
    }
    const keptAt = kept ? new Date() : null;
    await tx
      .update(appVersions)
      .set({ keptAt, keptByUserId: kept ? actor.userId : null })
      .where(eq(appVersions.id, version.id));
    await writeAudit(
      {
        workspaceId: app.workspaceId,
        actorUserId: actor.userId,
        actorKind: actor.kind,
        action: kept ? AUDIT_ACTIONS.appVersionKeep : AUDIT_ACTIONS.appVersionUnkeep,
        subjectType: 'app',
        target: app.slug,
        meta: { appId, version: number },
      },
      tx
    );
    return { number, kept, keptAt, changed: true, prunable: await prunableAfter() };
  });
}
