/**
 * GET/POST /admin/abuse — server half: the super-admin
 * moderation queue. SUPER-ADMIN ONLY: no session → /login; a signed-in user
 * who is not in SUPERADMIN_EMAIL → 403 (loader AND action).
 *
 * Shows the open reports (`?status=resolved` the resolved ones) with the app
 * behind each host, and every app that is currently taken down. Actions:
 *  - `takedown` (app, reason category, `confirmed=1`): unpublish + lock
 *    (`apps.locked_reason`), resolve the app's open reports, audit
 *    `admin.takedown`, e-mail the owners;
 *  - `restore` (app): clear the lock — NOT republished — audit
 *    `admin.restore`, e-mail the owners;
 *  - `resolve` (report): mark one report resolved, nothing else;
 *  - `gallery-hide` / `gallery-show` (app): hide an app's entry in
 *    the public gallery (or show it again) — audited `app.gallery_hidden` /
 *    `app.gallery_unhidden`; the owner cannot list a hidden app. The gallery
 *    section lists every listed or hidden app (only when GALLERY_ENABLED).
 *
 * A takedown has a confirm step: "Take down…" is a GET to
 * `?confirm=takedown&app=<id>&reason=<category>[&back=<path>]`, which renders
 * the app, its workspace, the reason and the effect on its addresses; only the
 * panel's POST carries `confirmed=1`, and a takedown without it is refused
 * (400) before anything changes. An app that is already taken down is refused
 * (409) — a double submit performs one takedown and sends one e-mail.
 */
import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import {
  AppsError,
  LOCK_REASONS,
  abuseReportsRetentionDays,
  findModerationApp,
  galleryEnabled,
  isLockReason,
  listAbuseReports,
  listGalleryForModeration,
  listLockedApps,
  lockCategory,
  publishedUrl,
  reasonLabel,
  resolveAbuseReport,
  restoreApp,
  setGalleryHidden,
  takedownApp,
  takedownPreview,
} from '@drobek/apps';
import { isSuperAdmin, requireSessionUser, type SessionUser } from '@drobek/auth';
import { createConsoleLogger } from '@drobek/core';
import { mailOwnersAboutModeration } from '../abuse-mail.server.js';
import { isConfirmed, safeModerationBack, takedownEffects } from '../moderation-confirm.js';

const log = createConsoleLogger('abuse');

async function requireSuperAdmin(request: Request): Promise<SessionUser> {
  const user = await requireSessionUser(request);
  if (!isSuperAdmin(user.email)) {
    throw data({ message: 'Only the operator of this server (a super-admin) can open the moderation queue.' }, { status: 403 });
  }
  return user;
}

const appPath = (workspaceSlug: string, slug: string) => `/workspaces/${workspaceSlug}/apps/${slug}`;

/** The takedown confirm panel for `?confirm=takedown`, or the reason it cannot be shown. */
async function takedownConfirm(params: URLSearchParams) {
  if (params.get('confirm') !== 'takedown') return { confirm: null, confirmError: null };
  const back = safeModerationBack(params.get('back'));
  const reason = params.get('reason') ?? '';
  if (!isLockReason(reason)) {
    return { confirm: null, confirmError: 'Pick a takedown reason from the list, then choose Take down again.' };
  }
  const app = await takedownPreview(params.get('app') ?? '');
  if (!app) return { confirm: null, confirmError: 'That app no longer exists, so there is nothing to take down.' };
  if (app.lockedReason !== null) {
    return {
      confirm: null,
      confirmError: `${app.slug} is already taken down (${reasonLabel(lockCategory(app.lockedReason))}). Nothing changed; restore it below first if the reason is wrong.`,
    };
  }
  const publicUrl = app.published ? publishedUrl(app.slug) : null;
  return {
    confirm: {
      appId: app.id,
      slug: app.slug,
      name: app.name,
      workspaceSlug: app.workspaceSlug,
      workspaceName: app.workspaceName,
      appPath: appPath(app.workspaceSlug, app.slug),
      publicUrl,
      reason,
      reasonLabel: reasonLabel(reason),
      effects: takedownEffects(
        { slug: app.slug, published: app.published, publicUrl, domains: app.domains, openReports: app.openReports, galleryListed: app.galleryListed },
        reasonLabel(reason)
      ),
      back,
    },
    confirmError: null,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireSuperAdmin(request);
  const params = new URL(request.url).searchParams;
  const status = params.get('status') === 'resolved' ? 'resolved' : 'open';
  const gallery = galleryEnabled();
  const [reports, locked, listed, confirm] = await Promise.all([
    listAbuseReports({ status }),
    listLockedApps(),
    gallery ? listGalleryForModeration() : Promise.resolve(null),
    takedownConfirm(params),
  ]);
  return data(
    {
      status,
      retentionDays: abuseReportsRetentionDays(),
      ...confirm,
      reasons: LOCK_REASONS.map((value) => ({ value, label: reasonLabel(value) })),
      reports: reports.map((r) => ({
        id: r.id,
        host: r.host,
        reason: r.reason,
        reasonLabel: reasonLabel(r.reason),
        details: r.details,
        reporterEmail: r.reporterEmail,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolvedBy: r.resolvedByEmail,
        app: r.app
          ? {
              id: r.app.id,
              slug: r.app.slug,
              name: r.app.name,
              workspaceSlug: r.app.workspaceSlug,
              appPath: appPath(r.app.workspaceSlug, r.app.slug),
              publicUrl: r.app.published && r.app.lockedReason === null ? publishedUrl(r.app.slug) : null,
              locked: r.app.lockedReason !== null,
              lockedReason: r.app.lockedReason ? lockCategory(r.app.lockedReason) : null,
            }
          : null,
      })),
      locked: locked.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        workspaceSlug: a.workspaceSlug,
        appPath: appPath(a.workspaceSlug, a.slug),
        reason: lockCategory(a.lockedReason),
        reasonLabel: reasonLabel(lockCategory(a.lockedReason)),
      })),
      // Null = this server runs no gallery.
      gallery: listed
        ? listed.map((g) => ({
            id: g.id,
            slug: g.slug,
            name: g.name,
            description: g.description,
            workspaceSlug: g.workspaceSlug,
            appPath: appPath(g.workspaceSlug, g.slug),
            publicUrl: g.published ? publishedUrl(g.slug) : null,
            hidden: g.hiddenAt !== null,
            visible: g.visible,
          }))
        : null,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

type ActionResult = { ok: true; message: string } | { ok: false; error: string };

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireSuperAdmin(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  try {
    if (intent === 'resolve') {
      const ok = await resolveAbuseReport(String(form.get('reportId') ?? ''), user.id);
      return data<ActionResult>(ok ? { ok: true, message: 'Report marked resolved.' } : { ok: false, error: 'That report is not open.' }, {
        status: ok ? 200 : 404,
      });
    }
    if (intent === 'takedown' || intent === 'restore') {
      const app = await findModerationApp(String(form.get('appId') ?? ''));
      if (!app) return data<ActionResult>({ ok: false, error: 'No such app.' }, { status: 404 });
      if (intent === 'takedown') {
        const reason = String(form.get('reason') ?? '');
        if (!isConfirmed(form)) {
          return data<ActionResult>(
            { ok: false, error: 'Nothing was taken down: confirm the takedown first. Choose Take down, check the app and the reason, then confirm.' },
            { status: 400 }
          );
        }
        if (app.lockedReason !== null) {
          return data<ActionResult>({ ok: false, error: `${app.slug} is already taken down. Nothing changed.` }, { status: 409 });
        }
        const out = await takedownApp({ appId: app.id, reason, actorUserId: user.id, log });
        if (!out.changed) {
          return data<ActionResult>({ ok: false, error: `${app.slug} is already taken down. Nothing changed.` }, { status: 409 });
        }
        log.warn('app taken down by a super-admin', {
          event: 'admin_takedown',
          app_id: app.id,
          slug: app.slug,
          reason,
          unpublished_version_id: out.unpublishedVersionId,
        });
        await mailOwnersAboutModeration({ kind: 'takedown', app, reason }, log);
        return data<ActionResult>({ ok: true, message: `${app.slug} was taken down (${reason}).` });
      }
      const out = await restoreApp({ appId: app.id, actorUserId: user.id, log });
      if (!out.wasLocked) return data<ActionResult>({ ok: false, error: `${app.slug} is not taken down.` }, { status: 409 });
      log.warn('app restored by a super-admin', { event: 'admin_restore', app_id: app.id, slug: app.slug, reason: out.reason });
      await mailOwnersAboutModeration({ kind: 'restore', app, reason: out.reason ?? 'other' }, log);
      return data<ActionResult>({ ok: true, message: `${app.slug} was restored. It stays unpublished until its owner publishes.` });
    }
    if (intent === 'gallery-hide' || intent === 'gallery-show') {
      const app = await findModerationApp(String(form.get('appId') ?? ''));
      if (!app) return data<ActionResult>({ ok: false, error: 'No such app.' }, { status: 404 });
      const hide = intent === 'gallery-hide';
      const out = await setGalleryHidden(app.id, hide, user.id);
      log.warn(hide ? 'gallery entry hidden by a super-admin' : 'gallery entry shown again by a super-admin', {
        event: hide ? 'admin_gallery_hide' : 'admin_gallery_show',
        app_id: app.id,
        slug: app.slug,
        changed: out.changed,
      });
      return data<ActionResult>({
        ok: true,
        message: hide ? `${app.slug} is hidden from the gallery.` : `${app.slug} may be shown in the gallery again.`,
      });
    }
    return data<ActionResult>({ ok: false, error: 'Unsupported action.' }, { status: 400 });
  } catch (err) {
    if (err instanceof AppsError && (err.code === 'invalid_reason' || err.code === 'not_found')) {
      return data<ActionResult>({ ok: false, error: err.message }, { status: err.code === 'not_found' ? 404 : 400 });
    }
    throw err;
  }
}
