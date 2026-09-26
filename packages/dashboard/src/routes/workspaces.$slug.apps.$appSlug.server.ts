/**
 * GET/POST /workspaces/:slug/apps/:appSlug — server half of the app page's
 * Overview tab (NSO-288; PHY-74 slice before it).
 *
 * GET (viewer+): the shared app header (URLs, compile state, lock) + the
 * VERSION HISTORY (number, time, author, reasoning, compile status + first
 * error, a link to `<slug>--v<N>`) + the insight panels (recent errors,
 * traffic / 404s) + the public gallery section (NSO-340; absent unless
 * GALLERY_ENABLED). A viewer sees everything but no controls.
 *
 * POST (editor+): `appAction` — publish (an older version = the rollback),
 * restore to the working copy, the gallery listing, and the header's
 * unpublish / unlock; the role gate runs before anything else (viewer → 403,
 * non-member → 404, anonymous → /login). A pre-NSO-288 form with only `versionId` still
 * publishes.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { GALLERY_DESCRIPTION_MAX, galleryEnabled, galleryState, listVersions, versionUrl } from '@drobek/apps';
import {
  queryAppErrors,
  queryAppLogs,
  type AppErrorsView,
  type AppLogsView,
} from '@drobek/insights';
import { appAction, appHeaderData, emailsOf, loadAppPage } from '../app-page.server.js';
import { compileSummary } from '../app-view.js';
import { loadPendingBanner } from '../pending-banner.server.js';
import { shapeVersionHistory } from '../view.js';

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

export async function loader({ request, params }: LoaderFunctionArgs) {
  const page = await loadAppPage(request, params, 'viewer');
  const { app } = page;

  const raw = await listVersions(app.id, { limit: 100 });
  const [header, emails, errors, logs] = await Promise.all([
    appHeaderData(page),
    emailsOf(raw.map((v) => v.createdByUserId)),
    // PHY-123 insight panels — best effort: a signals hiccup degrades to
    // empty, never 500s the page. Stored text is React-escaped on render.
    queryAppErrors(app.id).catch(() => EMPTY_ERRORS),
    queryAppLogs(app.id).catch(() => EMPTY_LOGS),
  ]);
  const byId = new Map(raw.map((v) => [v.id, v]));
  const latestNumber = raw[0]?.number ?? 0;
  const versions = shapeVersionHistory(raw).map((v) => {
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
      restorable: v.number !== latestNumber,
    };
  });

  return {
    header,
    versions,
    errors,
    logs,
    // NSO-293: a taken-down app shows no publish / restore controls (the action answers 423 anyway).
    canPublish: header.canEdit && header.lockedByAdmin === null,
    // M2-02: "N changes await confirmation" (PendingBanner).
    pendingBanner: await loadPendingBanner(app, header.workspace.slug, app.slug),
    // NSO-340: the public gallery section (null = the server runs no gallery).
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
