/**
 * GET/POST /workspaces/:slug/apps/:appSlug — server half of the app page's
 * Overview tab.
 *
 * GET (viewer+): the shared app header (URLs, compile state, lock), the
 * newest version's publish readiness report, the insight panels (recent
 * errors, traffic / 404s), the public gallery section (absent unless
 * GALLERY_ENABLED) and the VERSION HISTORY:
 *  - the pinned versions (live, preview, kept), whatever page is shown;
 *  - one page of APP_VERSIONS_PAGE versions, newest first, from `?before=<N>`
 *    (versions numbered below N; absent: from the newest), with the cursor of
 *    the next older page; failed builds in a row are grouped on the page;
 *  - what the history retention keeps (APP_VERSIONS_KEEP of the workspace),
 *    how many versions are stored and which of them the page shows;
 *  - the clean-up preview for `?cleanup=<N>[&failedOnly=1]` (editor+): what
 *    a clean-up up to version N would delete and why the others stay;
 *  - the result banner a keep / unkeep / clean-up redirected with.
 * A viewer sees everything but no controls.
 *
 * POST (editor+): `appAction` — publish (an older version = the rollback),
 * restore to the working copy, keep / unkeep a version, delete old versions,
 * the gallery listing, and the header's unpublish / unlock; the role gate runs
 * before anything else (viewer → 403, non-member → 404, anonymous → /login).
 */
import { type HeadersArgs, type LoaderFunctionArgs } from 'react-router';
import {
  AppsError,
  GALLERY_DESCRIPTION_MAX,
  galleryEnabled,
  galleryState,
  listVersions,
  pinnedVersions,
  planVersionDeletion,
  versionRetention,
  versionStorageLimitsOf,
  versionUrl,
  versionsPageSize,
  type VersionProtection,
  type VersionSummary,
} from '@drobek/apps';
import {
  queryAppErrors,
  queryAppLogs,
  type AppErrorsView,
  type AppLogsView,
} from '@drobek/insights';
import { moduleRuntime } from '@drobek/modules';
import { appAction, appHeaderData, emailsOf, loadAppPage } from '../app-page.server.js';
import { compileSummary } from '../app-view.js';
import { parseDuplicateResult } from '../duplicate-result.server.js';
import { loadPendingBanner } from '../pending-banner.server.js';
import { loadReadiness } from '../readiness.server.js';
import { loadSyncBanner } from '../sync-banner.server.js';
import { countRanges, parseVersionNumber, versionResultFrom } from '../version-history.js';
import { VERSION_PROTECTION_LABEL, groupFailedRuns, shapeVersionHistory } from '../view.js';

const EMPTY_ERRORS: AppErrorsView = {
  totalEvents: 0,
  distinctErrors: 0,
  errors: [],
};
const EMPTY_LOGS: AppLogsView = {
  requests: 0,
  count5xx: 0,
  top404Paths: [],
  recentVersions: [],
};

/** The clean-up preview of `?cleanup=<N>[&failedOnly=1]`, or why it cannot be shown. */
async function cleanupPreview(appId: string, params: URLSearchParams) {
  if (!params.has('cleanup')) return { cleanup: null, cleanupError: null };
  const upTo = parseVersionNumber(params.get('cleanup'));
  if (!upTo) {
    return { cleanup: null, cleanupError: 'Enter a version number to clean up to, e.g. 12 deletes what may go among v1–v12.' };
  }
  const failedOnly = params.get('failedOnly') === '1';
  try {
    const plan = await planVersionDeletion(appId, upTo, { failedOnly });
    const stays = (Object.keys(VERSION_PROTECTION_LABEL) as VersionProtection[])
      .filter((reason) => (plan.skipped[reason] ?? []).length > 0)
      .map((reason) => {
        const ranges = plan.skipped[reason] ?? [];
        return { reason, label: VERSION_PROTECTION_LABEL[reason], ranges, count: countRanges(ranges) };
      });
    return {
      cleanup: { upTo, failedOnly, count: plan.count, deleted: plan.deleted, stays, stayCount: stays.reduce((n, s) => n + s.count, 0) },
      cleanupError: null,
    };
  } catch (err) {
    if (err instanceof AppsError) return { cleanup: null, cleanupError: err.message };
    throw err;
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const page = await loadAppPage(request, params, 'viewer');
  const { app } = page;
  const url = new URL(request.url);
  const before = parseVersionNumber(url.searchParams.get('before'));

  const limits = versionStorageLimitsOf(await (await moduleRuntime()).workspaceLimits(app.workspaceId));
  const [{ versions: raw, nextBefore }, pinnedRaw, retention, header] = await Promise.all([
    listVersions(app.id, { limit: versionsPageSize(), ...(before ? { before } : {}) }),
    pinnedVersions(app.id),
    versionRetention(app.id, limits.keep),
    appHeaderData(page),
  ]);
  const newest = retention.newest;
  const canClean = header.canEdit && header.lockedByAdmin === null;
  const [emails, errors, logs, readiness, cleanup] = await Promise.all([
    emailsOf([...raw, ...pinnedRaw].map((v) => v.createdByUserId)),
    // Insight panels — best effort: a signals hiccup degrades to
    // empty, never 500s the page. Stored text is React-escaped on render.
    queryAppErrors(app.id).catch(() => EMPTY_ERRORS),
    queryAppLogs(app.id).catch(() => EMPTY_LOGS),
    // The newest version's publish readiness report (best effort, never a 500).
    newest !== null ? loadReadiness(app, newest) : null,
    canClean ? cleanupPreview(app.id, url.searchParams) : { cleanup: null, cleanupError: null },
  ]);

  const shape = (rows: VersionSummary[]) => {
    const byId = new Map(rows.map((v) => [v.id, v]));
    return shapeVersionHistory(rows).map((v) => {
      const r = byId.get(v.id);
      const compile = compileSummary(r?.compileErrors);
      return {
        ...v,
        author: r?.createdByUserId ? (emails.get(r.createdByUserId) ?? null) : null,
        compileErrorCount: compile.count,
        compileFirstError: compile.first,
        // The version host serves only versions that compiled.
        openUrl: v.compileStatus === 'ok' ? versionUrl(app.slug, v.number) : null,
        // Restoring the newest version would only duplicate it.
        restorable: v.number !== newest,
      };
    });
  };
  const versions = shape(raw);

  return {
    header,
    pinned: shape(pinnedRaw),
    history: groupFailedRuns(versions),
    paging: { before, nextBefore },
    retention: {
      keep: retention.keep,
      keptMax: limits.keptMax,
      stored: retention.stored,
      oldest: retention.oldest,
      newest,
      // "Showing vX–vY of N": this page's newest and oldest version.
      shownTo: versions[0]?.number ?? null,
      shownFrom: versions[versions.length - 1]?.number ?? null,
    },
    versionResult: versionResultFrom(url.searchParams),
    ...cleanup,
    errors,
    logs,
    readiness,
    // A taken-down app shows no publish / restore controls (the action answers 423 anyway).
    canPublish: header.canEdit && header.lockedByAdmin === null,
    // Keeping only protects history, so it stays open on a taken-down app.
    canKeep: header.canEdit,
    canClean,
    // "N changes await confirmation" (PendingBanner).
    pendingBanner: await loadPendingBanner(app, header.workspace.slug, app.slug),
    // "a scheduled import stopped" (SyncBanner).
    syncBanner: await loadSyncBanner(app, header.workspace.slug),
    // Right after /duplicate/:slug, what happened to the original's module settings.
    duplicateResult: parseDuplicateResult(
      url,
      `/workspaces/${encodeURIComponent(header.workspace.slug)}/apps/${encodeURIComponent(app.slug)}/modules`
    ),
    // The public gallery section (null = the server runs no gallery).
    gallery: galleryEnabled()
      ? {
          ...galleryState(app),
          published: app.publishedVersionId !== null,
          passwordProtected: app.visibility === 'password',
          descriptionMax: GALLERY_DESCRIPTION_MAX,
        }
      : null,
  };
}

export const action = appAction;

/** Without a `headers` export React Router drops the `Retry-After` of a rate-limited action. */
export function headers({ actionHeaders, loaderHeaders }: HeadersArgs) {
  return actionHeaders.has('Retry-After') ? actionHeaders : loaderHeaders;
}
