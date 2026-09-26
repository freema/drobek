/**
 * GET/POST /admin/abuse — server half (M4-02, NSO-293): the super-admin
 * moderation queue. SUPER-ADMIN ONLY: no session → /login; a signed-in user
 * who is not in SUPERADMIN_EMAIL → 403 (loader AND action).
 *
 * Shows the open reports (`?status=resolved` the resolved ones) with the app
 * behind each host, and every app that is currently taken down. Actions:
 *  - `takedown` (app, reason category): unpublish + lock
 *    (`apps.locked_reason`), resolve the app's open reports, audit
 *    `admin.takedown`, e-mail the owners;
 *  - `restore` (app): clear the lock — NOT republished — audit
 *    `admin.restore`, e-mail the owners;
 *  - `resolve` (report): mark one report resolved, nothing else;
 *  - `gallery-hide` / `gallery-show` (app, NSO-340): hide an app's entry in
 *    the public gallery (or show it again) — audited `app.gallery_hidden` /
 *    `app.gallery_unhidden`; the owner cannot list a hidden app. The gallery
 *    section lists every listed or hidden app (only when GALLERY_ENABLED).
 */
import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import {
  AppsError,
  LOCK_REASONS,
  findModerationApp,
  galleryEnabled,
  listAbuseReports,
  listGalleryForModeration,
  listLockedApps,
  lockCategory,
  reasonLabel,
  resolveAbuseReport,
  restoreApp,
  setGalleryHidden,
  takedownApp,
} from '@drobek/apps';
import { isSuperAdmin, requireSessionUser, type SessionUser } from '@drobek/auth';
import { createConsoleLogger } from '@drobek/core';
import { mailOwnersAboutModeration } from '../abuse-mail.server.js';

const log = createConsoleLogger('abuse');

async function requireSuperAdmin(request: Request): Promise<SessionUser> {
  const user = await requireSessionUser(request);
  if (!isSuperAdmin(user.email)) {
    throw data({ message: 'Only the operator of this server (a super-admin) can open the moderation queue.' }, { status: 403 });
  }
  return user;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireSuperAdmin(request);
  const status = new URL(request.url).searchParams.get('status') === 'resolved' ? 'resolved' : 'open';
  const gallery = galleryEnabled();
  const [reports, locked, listed] = await Promise.all([
    listAbuseReports({ status }),
    listLockedApps(),
    gallery ? listGalleryForModeration() : Promise.resolve(null),
  ]);
  return data(
    {
      status,
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
        reason: lockCategory(a.lockedReason),
        reasonLabel: reasonLabel(lockCategory(a.lockedReason)),
      })),
      // NSO-340: null = this server runs no gallery.
      gallery: listed
        ? listed.map((g) => ({
            id: g.id,
            slug: g.slug,
            name: g.name,
            description: g.description,
            workspaceSlug: g.workspaceSlug,
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
        const out = await takedownApp({ appId: app.id, reason, actorUserId: user.id, log });
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
