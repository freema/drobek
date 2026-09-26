/**
 * The server half every app-page tab shares (NSO-288):
 *
 *  - `loadAppPage` — role gate (requireWorkspaceRole: non-member / unknown
 *    → 404, anonymous → /login) + the live app of THIS workspace (a deleted
 *    app → 404);
 *  - `appHeaderData` — what <AppHeader> shows: preview / production URL,
 *    compile state of the newest version, the published version and the
 *    single-writer lease ("an agent of X is working, last write N s ago");
 *  - `appAction` — EVERY app mutation of the dashboard, dispatched on the
 *    form's `intent`: publish, restore, unpublish, unlock, visibility,
 *    frame-ancestors, gallery (NSO-340: list / relist / unlist), delete.
 *    The editor gate runs FIRST (a viewer → 403, before the form is even
 *    read); the global origin check
 *    (createOriginCheckMiddleware) already refused cross-origin posts. Each
 *    mutation is a @drobek/apps function (the same ones the MCP tools use),
 *    which writes its audit row; the app hosts' cache is busted right after.
 *    A taken-down app (NSO-293, `apps.locked_reason`) answers publish /
 *    restore / unpublish with 423 `app_locked_by_admin`; the header carries
 *    `lockedByAdmin` for <LockedByAdminNotice>.
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import {
  AppsError,
  getVersion,
  lockedByAdminError,
  notifyAppChanged,
  previewUrl,
  publish,
  publishedUrl,
  readAppLease,
  releaseAppLease,
  restore,
  setAppVisibility,
  setFrameAncestors,
  setGalleryListing,
  softDeleteApp,
  unpublishApp,
  type Actor,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { appVersions, getDb, users } from '@drobek/db';
import { moduleRuntime } from '@drobek/modules';
import { hashAppPassword, parseFrameAncestors } from '@drobek/serving';
import { requireWorkspaceRole, type WorkspaceAccess } from '@drobek/tenancy';
import { lockedByAdminView } from './app-api.server.js';
import { appBasePath } from './app-tabs.js';
import { compileSummary, safeRedirectTo, shapeLock, type LockView } from './app-view.js';
import { loadAppForView, type AppDetail } from './apps.server.js';
import type { LockedByAdminView } from './locked-notice.js';
import { canPublish, type CompileStatusName } from './view.js';

export const APP_PASSWORD_MIN = 8;
export const APP_PASSWORD_MAX = 200;

export interface AppPage {
  access: WorkspaceAccess;
  app: AppDetail;
}

/** Role gate + the live app of this workspace; 404 for anything else. */
export async function loadAppPage(
  request: Request,
  params: LoaderFunctionArgs['params'],
  minRole: 'viewer' | 'editor' = 'viewer'
): Promise<AppPage> {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), minRole);
  const app = await loadAppForView(access.workspace.id, String(params.appSlug ?? ''));
  if (!app) throw data({ message: 'Not found' }, { status: 404 });
  return { access, app };
}

/** e-mail by user id (for version authors and the lease holder). */
export async function emailsOf(userIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((u): u is string => !!u))];
  if (ids.length === 0) return new Map();
  const rows = await getDb().select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.email]));
}

export interface AppHeaderData {
  workspace: { slug: string; name: string };
  slug: string;
  name: string | null;
  basePath: string;
  visibility: 'public' | 'password';
  previewUrl: string;
  publishedUrl: string;
  publishedVersion: number | null;
  latest: { number: number; compileStatus: CompileStatusName; errorCount: number } | null;
  /** The version the preview host serves (the newest one that compiled). */
  previewVersion: number | null;
  lock: LockView | null;
  canEdit: boolean;
  /** NSO-293: set when a super-admin took the app down (the banner; publish/restore are refused). */
  lockedByAdmin: LockedByAdminView | null;
}

/** Everything <AppHeader> renders. The lease read is best effort (Redis down → no banner). */
export async function appHeaderData({ access, app }: AppPage): Promise<AppHeaderData> {
  const db = getDb();
  const [[latest], [lastOk], published, lease] = await Promise.all([
    db
      .select({
        number: appVersions.number,
        compileStatus: appVersions.compileStatus,
        compileErrors: appVersions.compileErrors,
      })
      .from(appVersions)
      .where(eq(appVersions.appId, app.id))
      .orderBy(desc(appVersions.number))
      .limit(1),
    db
      .select({ number: max(appVersions.number) })
      .from(appVersions)
      .where(and(eq(appVersions.appId, app.id), eq(appVersions.compileStatus, 'ok'))),
    app.publishedVersionId ? getVersion(app.id, { id: app.publishedVersionId }) : Promise.resolve(null),
    readAppLease(app.id).catch(() => null),
  ]);
  const emails = await emailsOf([lease?.holder_user_id ?? null]);
  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    slug: app.slug,
    name: app.name,
    basePath: appBasePath(access.workspace.slug, app.slug),
    visibility: app.visibility,
    previewUrl: previewUrl(app.slug),
    publishedUrl: publishedUrl(app.slug),
    publishedVersion: published?.number ?? null,
    latest: latest
      ? {
          number: latest.number,
          compileStatus: latest.compileStatus as CompileStatusName,
          errorCount: compileSummary(latest.compileErrors).count,
        }
      : null,
    previewVersion: lastOk?.number ?? null,
    lock: shapeLock(lease, emails, access.user.id, Date.now()),
    canEdit: canPublish(access.effectiveRole),
    lockedByAdmin: lockedByAdminView(app.lockedReason),
  };
}

/**
 * NSO-342: the header of an app sub-page whose loader resolved the access
 * itself (Data, Forms, Users, Uploads, Logs, Modules, Domains) — the same
 * app lookup (a deleted app / another workspace's → 404) + appHeaderData.
 */
export async function appHeaderFor(access: WorkspaceAccess, appSlug: string): Promise<AppHeaderData> {
  const app = await loadAppForView(access.workspace.id, appSlug);
  if (!app) throw data({ message: 'Not found' }, { status: 404 });
  return appHeaderData({ access, app });
}

interface AppActionError {
  error: string;
  intent: string;
}

function fail(status: number, intent: string, error: string) {
  return data<AppActionError>({ error, intent }, { status });
}

function versionNumber(raw: FormDataEntryValue | null): number | null {
  const n = Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The one action of every app-page route. On success it redirects back —
 * to `redirectTo` when that is a tab of this app (the header's forms post
 * here from any tab), else to the posting page; `delete` lands on the apps
 * list. Expected failures come back as `{ error, intent }` with 400 (409 when
 * another member's agent holds the lease, 423 when a super-admin took the app
 * down) for the page to show.
 */
export async function appAction({ request, params }: ActionFunctionArgs) {
  // The editor gate FIRST: a viewer gets 403 before anything is read or changed.
  const { access, app } = await loadAppPage(request, params, 'editor');
  const form = await request.formData();
  // Pre-NSO-288 forms posted only `versionId` (the publish button).
  const intent = String(form.get('intent') ?? (form.has('versionId') ? 'publish' : ''));
  const actor: Actor = { userId: access.user.id, kind: actorKindForSurface('web') };
  const base = appBasePath(access.workspace.slug, app.slug);
  const back = safeRedirectTo(form.get('redirectTo') ?? new URL(request.url).pathname, base);
  const changed = (kind: 'publish' | 'unpublish' | 'version' | 'settings' | 'delete', version?: number) =>
    notifyAppChanged({ app_id: app.id, slug: app.slug, kind, ...(version ? { version } : {}) });

  // NSO-293: a taken-down app is not published, restored or unpublished from
  // here (@drobek/apps refuses publish/restore itself; unpublish is checked
  // here so all three answer the same 423).
  if (app.lockedReason && (intent === 'publish' || intent === 'restore' || intent === 'unpublish')) {
    return fail(423, intent, lockedByAdminError(app.lockedReason).message);
  }

  try {
    switch (intent) {
      case 'publish': {
        let versionId = String(form.get('versionId') ?? '').trim();
        if (!versionId) {
          const n = versionNumber(form.get('version'));
          const v = n ? await getVersion(app.id, { number: n }) : null;
          if (!v) return fail(400, intent, 'Pick a version to publish.');
          versionId = v.id;
        }
        const out = await publish(app.id, versionId, actor);
        // The production host serves the new version from the next request.
        await changed('publish', out.number);
        // Platform modules react to a publish (best effort, errors logged).
        await (await moduleRuntime()).runHook('onPublish', {
          id: app.id,
          slug: app.slug,
          workspaceId: access.workspace.id,
          version: out.number,
        });
        break;
      }
      case 'restore': {
        const n = versionNumber(form.get('version'));
        if (!n) return fail(400, intent, 'Pick a version to restore.');
        // Never pull the working copy from under another member's agent.
        const lease = await readAppLease(app.id).catch(() => null);
        if (lease && lease.holder_user_id !== access.user.id) {
          const holder = (await emailsOf([lease.holder_user_id])).get(lease.holder_user_id) ?? 'another member';
          return fail(409, intent, `An agent of ${holder} is writing this app right now — unlock it first, then restore.`);
        }
        const out = await restore(app.id, n, actor, { reasoning: `Restore of version ${n} (dashboard)` });
        await changed('version', out.number);
        break;
      }
      case 'unpublish': {
        await unpublishApp(app.id, actor);
        await changed('unpublish');
        break;
      }
      case 'unlock': {
        await releaseAppLease({ id: app.id, slug: app.slug, workspaceId: access.workspace.id }, actor);
        break;
      }
      case 'visibility': {
        const mode = String(form.get('visibility') ?? '');
        if (mode === 'public') {
          await setAppVisibility(app.id, { visibility: 'public' }, actor);
        } else if (mode === 'password') {
          const password = String(form.get('password') ?? '');
          if (password && (password.length < APP_PASSWORD_MIN || password.length > APP_PASSWORD_MAX)) {
            return fail(400, intent, `The password must be ${APP_PASSWORD_MIN}–${APP_PASSWORD_MAX} characters.`);
          }
          await setAppVisibility(
            app.id,
            { visibility: 'password', passwordHash: password ? await hashAppPassword(password) : null },
            actor
          );
        } else {
          return fail(400, intent, 'Choose public or password.');
        }
        await changed('settings');
        break;
      }
      case 'frame-ancestors': {
        const raw = String(form.get('frameAncestors') ?? '').trim();
        let value: string | null = null;
        if (raw) {
          const parsed = parseFrameAncestors(raw);
          if (!parsed) {
            return fail(
              400,
              intent,
              "Use 'self' and/or up to 10 http(s) origins separated by spaces, e.g. https://intranet.example.com."
            );
          }
          value = parsed === "'none'" ? null : parsed;
        }
        await setFrameAncestors(app.id, value, actor);
        await changed('settings');
        break;
      }
      case 'gallery': {
        // NSO-340: "Show in the gallery" + the public description. Listing
        // needs a published app (@drobek/apps refuses otherwise); unchecking
        // unlists. The same function backs the MCP tool set_gallery_listing.
        const listed = form.get('listed') === 'on' || form.get('listed') === 'true';
        await setGalleryListing(
          app.id,
          listed ? { listed: true, description: String(form.get('description') ?? '') } : { listed: false },
          actor
        );
        break;
      }
      case 'delete': {
        if (String(form.get('confirm') ?? '').trim() !== app.slug) {
          return fail(400, intent, `Type the app's address "${app.slug}" to confirm the delete.`);
        }
        await softDeleteApp(app.id, actor);
        // Every host of the app answers 404 from the next request.
        await changed('delete');
        return redirect(`/workspaces/${access.workspace.slug}/apps?deleted=${encodeURIComponent(app.slug)}`);
      }
      default:
        return fail(400, intent, 'Unknown action.');
    }
  } catch (err) {
    // Expected failures (an unknown version, not_publishable, not_published,
    // invalid_settings, gallery_hidden) carry a caller-safe message; the
    // gallery switch of a server without a gallery is not there at all (404).
    // A takedown that landed after the page loaded → 423 like the pre-check.
    if (err instanceof AppsError && err.code === 'app_locked_by_admin') return fail(423, intent, err.message);
    if (err instanceof AppsError && err.code === 'gallery_disabled') return fail(404, intent, err.message);
    if (err instanceof AppsError) return fail(400, intent, err.message);
    throw err;
  }
  return redirect(back);
}
