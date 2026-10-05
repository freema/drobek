/**
 * The version history tools (MCP parity with the dashboard's History tab):
 * list_versions pages the history, keep_version keeps a version (or stops
 * keeping it), delete_versions deletes old versions. Each body calls the SAME
 * @drobek/apps function as the dashboard (`listVersions` / `pinnedVersions`,
 * `keepVersion`, `planVersionDeletion` / `deleteVersions` — each change writes
 * its audit row, here as the agent).
 *
 * Roles: listing needs any role in the workspace, keeping and deleting editor+.
 * A page holds at most APP_VERSIONS_PAGE versions; keeping is capped per app at
 * APP_VERSIONS_KEPT_MAX of the app's workspace and works on a taken-down app
 * (it only protects history). Deleting is irreversible, so it needs the user's
 * explicit yes (`user_confirmed: true`, checked last, after the arguments and
 * the takedown check): without it the answer is `user_confirmation_required`
 * with the plan and its `plan_id`, and nothing changes. The confirmed call
 * passes that `plan_id` back and deletes exactly that plan: when the versions
 * that would go changed in between it answers `plan_changed` and deletes
 * nothing (`deleteVersions`' `expectedPlanId`). A taken-down app refuses the clean-up
 * (`app_locked_by_admin`): its versions are the takedown's evidence. The
 * published version, the preview's, kept versions, rollback sets, the newest
 * version and the last hour's always stay, each reported with its reason.
 */
import {
  AppsError,
  deleteVersions,
  keepVersion,
  listVersions,
  pinnedVersions,
  planVersionDeletion,
  versionStorageLimitsOf,
  versionsPageSize,
  type Actor,
  type VersionDeletion,
  type VersionSummary,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { authorizeApp } from './access.js';
import { ToolError, lockedByAdmin, notFound } from './errors.js';
import type { AppRow } from './queries.js';
import type { CallContext } from './tools.js';

function actorOf(ctx: CallContext): Actor & { userId: string } {
  return { userId: ctx.principal.userId, kind: actorKindForSurface('mcp') };
}

function nameOf(app: AppRow): string {
  return app.name ?? app.slug;
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** One version of the history as the tools answer it. */
function versionOut(v: VersionSummary) {
  return {
    number: v.number,
    created_at: v.createdAt.toISOString(),
    actor_kind: v.actorKind,
    reasoning: v.reasoning,
    compile_status: v.compileStatus,
    published: v.published,
    preview: v.preview,
    kept: v.kept,
  };
}

// ── list_versions ────────────────────────────────────────────────────────────

export async function listVersionsTool(ctx: CallContext, args: { app_id: string; before?: number; limit?: number }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  const max = versionsPageSize(ctx.deps.env);
  if (args.limit !== undefined && !(positiveInt(args.limit) && args.limit <= max)) {
    throw new ToolError('invalid_params', `\`limit\` must be an integer from 1 to ${max} (APP_VERSIONS_PAGE).`, { limit: args.limit });
  }
  if (args.before !== undefined && !positiveInt(args.before)) {
    throw new ToolError('invalid_params', '`before` must be a version number (a positive integer): the `next_before` of the previous page.', {
      before: args.before,
    });
  }
  const [page, pinned] = await Promise.all([
    listVersions(app.id, { limit: args.limit ?? max, before: args.before }),
    pinnedVersions(app.id),
  ]);
  return {
    app_id: app.id,
    pinned: pinned.map(versionOut),
    versions: page.versions.map(versionOut),
    next_before: page.nextBefore,
  };
}

// ── keep_version ─────────────────────────────────────────────────────────────

export async function keepVersionTool(ctx: CallContext, args: { app_id: string; version: number; kept: boolean }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (!positiveInt(args.version)) throw new ToolError('invalid_params', '`version` must be a positive integer.', { version: args.version });
  if (typeof args.kept !== 'boolean') {
    throw new ToolError('invalid_params', '`kept` must be true (keep the version) or false (stop keeping it).');
  }
  const limits = versionStorageLimitsOf(await ctx.modules.workspaceLimits(app.workspaceId), ctx.deps.env);
  let out: Awaited<ReturnType<typeof keepVersion>>;
  try {
    out = await keepVersion(app.id, args.version, args.kept, actorOf(ctx), { keptMax: limits.keptMax, keep: limits.keep });
  } catch (err) {
    if (err instanceof AppsError && (err.code === 'not_found' || err.code === 'limit_exceeded')) {
      throw new ToolError(err.code, err.message, { ...err.details });
    }
    throw err;
  }
  const n = out.number;
  const note = out.kept
    ? `Version ${n} is kept${out.changed ? ' now' : ' already'}: neither the history retention nor a clean-up deletes it while it is kept.`
    : out.prunable
      ? `Version ${n} is not kept${out.changed ? ' any more' : ''}. It is older than the app's newest ${limits.keep} versions and nothing else protects it, so the next hourly history retention deletes it.`
      : `Version ${n} is not kept${out.changed ? ' any more' : ''}; the history retention deletes it once it is older than the app's newest ${limits.keep} versions, unless it is published or kept for a rollback.`;
  return {
    app_id: app.id,
    version: n,
    kept: out.kept,
    changed: out.changed,
    ...(out.kept ? {} : { prunable: out.prunable }),
    note,
  };
}

// ── delete_versions ──────────────────────────────────────────────────────────

const REASON_TEXT: Record<string, string> = {
  published: 'the published version',
  preview: "the preview's version",
  kept: 'kept versions',
  rollback_assets: 'versions kept for a rollback',
  newest: 'the newest version',
  recent: "the last hour's versions",
};

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** An app deleted between the authorization and the clean-up answers like any unknown app. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppsError && err.code === 'not_found') throw notFound('app');
    throw err;
  }
}

/** "3-41, 45 (published) …" — the versions that stay, in one sentence part. */
function skippedText(skipped: VersionDeletion['skipped']): string {
  const parts = Object.entries(skipped).map(([reason, ranges]) => `${(ranges ?? []).join(', ')} (${REASON_TEXT[reason] ?? reason})`);
  return parts.length > 0 ? ` These stay: ${parts.join('; ')}.` : '';
}

export async function deleteVersionsTool(
  ctx: CallContext,
  args: { app_id: string; up_to: number; failed_only?: boolean; plan_id?: string; user_confirmed?: boolean }
) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (!positiveInt(args.up_to)) {
    throw new ToolError('invalid_params', '`up_to` must be a version number (a positive integer): the newest version the clean-up may delete.', {
      up_to: args.up_to,
    });
  }
  if (args.failed_only !== undefined && typeof args.failed_only !== 'boolean') {
    throw new ToolError('invalid_params', '`failed_only` must be true (only the versions whose build failed) or false.');
  }
  if (args.plan_id !== undefined && !(typeof args.plan_id === 'string' && /^[0-9a-f]{1,64}$/.test(args.plan_id))) {
    throw new ToolError('invalid_params', '`plan_id` must be the `plan_id` of the user_confirmation_required answer, unchanged.', {
      plan_id: args.plan_id,
    });
  }
  if (app.lockedReason) throw lockedByAdmin(app.lockedReason);
  const name = nameOf(app);
  const failedOnly = args.failed_only === true;
  const what = failedOnly ? 'failed builds' : 'versions';
  const plan = await run(() => planVersionDeletion(app.id, args.up_to, { failedOnly }));
  if (plan.count === 0) {
    return {
      app_id: app.id,
      deleted: [],
      count: 0,
      skipped: plan.skipped,
      note: `"${name}" has no ${what} up to version ${args.up_to} that may be deleted; nothing changed.${skippedText(plan.skipped)}`,
    };
  }
  if (args.user_confirmed !== true) {
    throw new ToolError(
      'user_confirmation_required',
      `Deleting ${plural(plan.count, failedOnly ? 'failed build' : 'old version')} of "${name}" (${plan.deleted.join(', ')}) removes them for good: their version hosts answer 404, and neither restore_version nor read_file can reach them again; it frees their share of the workspace's storage.${skippedText(plan.skipped)} Ask the user "Delete ${plan.count} old version${plan.count === 1 ? '' : 's'} of ${name} for good?", and call again with the same up_to and failed_only, plan_id: "${plan.planId}" and user_confirmed: true only after they say yes.`,
      {
        app_id: app.id,
        up_to: args.up_to,
        failed_only: failedOnly,
        delete: plan.deleted,
        count: plan.count,
        skipped: plan.skipped,
        plan_id: plan.planId,
      }
    );
  }
  if (args.plan_id === undefined) {
    throw new ToolError(
      'invalid_params',
      '`plan_id` is required with user_confirmed: true: call delete_versions without user_confirmed first, show the user the plan, and pass its `plan_id` once they said yes.'
    );
  }
  const expectedPlanId = args.plan_id;
  let out: VersionDeletion;
  try {
    out = await run(() => deleteVersions(app.id, args.up_to, { failedOnly, expectedPlanId }, actorOf(ctx)));
  } catch (err) {
    if (err instanceof AppsError && err.code === 'plan_changed') {
      throw new ToolError(
        'plan_changed',
        `${err.message} Call delete_versions again without user_confirmed for the current plan and ask the user again.`,
        { app_id: app.id, up_to: args.up_to, failed_only: failedOnly, plan_id: expectedPlanId }
      );
    }
    throw err;
  }
  return {
    app_id: app.id,
    deleted: out.deleted,
    count: out.count,
    skipped: out.skipped,
    note:
      out.count > 0
        ? `${plural(out.count, 'version')} of "${name}" deleted for good; their version hosts answer 404 now.${skippedText(out.skipped)}`
        : `Nothing was deleted: the versions were protected or gone by the time of the call.${skippedText(out.skipped)}`,
  };
}
