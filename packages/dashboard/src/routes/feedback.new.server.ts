/**
 * GET/POST /feedback/new?app=<slug>&v=<N>&path=&x=&y=&vw=&vh=&sel= — server
 * half of the page the preview's feedback widget opens in a new window: a
 * signed-in member of the app's workspace (any role, viewer included) writes
 * a note about what they saw.
 *
 * The query comes from the app host, an untrusted origin: every value is
 * cleaned (@drobek/apps feedback.ts) and only shown as context; the note's
 * text is never taken from the URL, so an app cannot put words in a member's
 * mouth. Signed out → /login?returnTo= back here; an unknown app and an app
 * of a workspace the account is not a member of answer the same 404. The POST
 * is a same-origin form (the dashboard's origin check), the page cannot be
 * framed (`frame-ancestors 'none'`), and the limits FEEDBACK_PER_USER_HOUR
 * (429 + Retry-After) and FEEDBACK_MAX_OPEN_PER_APP (409) apply.
 */
import { data, redirect, type ActionFunctionArgs, type HeadersArgs, type LoaderFunctionArgs } from 'react-router';
import { and, eq, isNull } from 'drizzle-orm';
import {
  AppsError,
  FEEDBACK_BODY_MAX,
  createFeedback,
  feedbackLimits,
  normalizeFeedbackPath,
  parseFeedbackAnchor,
  previewUrl,
  versionUrl,
  type FeedbackAnchor,
} from '@drobek/apps';
import { getSessionUser } from '@drobek/auth';
import { apps, getDb } from '@drobek/db';
import { getWorkspaceById, requireWorkspaceRole, type WorkspaceAccess } from '@drobek/tenancy';
import { appBasePath } from '../app-tabs.js';
import { anchorText, noteOpenUrl } from '../feedback-view.js';

const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'same-origin',
};

export function headers({ actionHeaders, loaderHeaders }: HeadersArgs) {
  const out = new Headers(PAGE_HEADERS);
  const retry = actionHeaders.get('Retry-After') ?? loaderHeaders.get('Retry-After');
  if (retry) out.set('Retry-After', retry);
  return out;
}

function notFound(): never {
  throw data({ message: 'Not found' }, { status: 404, headers: PAGE_HEADERS });
}

/** The live app with this slug and the caller's access to its workspace (viewer+), or a 404 / login redirect. */
async function reviewTarget(request: Request, slug: string): Promise<{ access: WorkspaceAccess; app: { id: string; slug: string; name: string | null } }> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 40) notFound();
  const [app] = await getDb()
    .select({ id: apps.id, slug: apps.slug, name: apps.name, workspaceId: apps.workspaceId })
    .from(apps)
    .where(and(eq(apps.slug, slug), isNull(apps.deletedAt)))
    .limit(1);
  if (!app) notFound();
  const workspace = await getWorkspaceById(app.workspaceId);
  if (!workspace) notFound();
  // A non-member gets the same 404 as an unknown app (requireWorkspaceRole's anti-enumeration).
  const access = await requireWorkspaceRole(request, workspace.slug, 'viewer');
  return { access, app: { id: app.id, slug: app.slug, name: app.name } };
}

interface ReviewContext {
  version: number | null;
  path: string;
  anchor: FeedbackAnchor | null;
}

function contextOf(read: (name: string) => string | null): ReviewContext {
  const v = Number(read('v'));
  return {
    version: Number.isSafeInteger(v) && v >= 1 ? v : null,
    path: normalizeFeedbackPath(read('path') ?? '/'),
    anchor: parseFeedbackAnchor({ x: read('x'), y: read('y'), vw: read('vw'), vh: read('vh'), selector: read('sel') ?? undefined }),
  };
}

function loginRedirect(request: Request): Response {
  const url = new URL(request.url);
  return redirect(`/login?returnTo=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
}

function pageData(access: WorkspaceAccess, app: { id: string; slug: string; name: string | null }, ctx: ReviewContext) {
  return {
    app: { slug: app.slug, name: app.name ?? app.slug },
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    email: access.user.email,
    context: {
      ...ctx,
      spot: anchorText(ctx.anchor),
      pageUrl: noteOpenUrl({ versionNumber: ctx.version, path: ctx.path }, { preview: previewUrl(app.slug), version: (n) => versionUrl(app.slug, n) }),
    },
    bodyMax: FEEDBACK_BODY_MAX,
    feedbackTab: `${appBasePath(access.workspace.slug, app.slug)}/feedback`,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getSessionUser(request);
  if (!user) throw loginRedirect(request);
  const url = new URL(request.url);
  const { access, app } = await reviewTarget(request, String(url.searchParams.get('app') ?? ''));
  return data(pageData(access, app, contextOf((k) => url.searchParams.get(k))), { headers: PAGE_HEADERS });
}

export type FeedbackActionResult = { ok: true; id: string } | { ok: false; error: string; body: string };

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return data<FeedbackActionResult>({ ok: false, error: 'Use the Send button.', body: '' }, { status: 405 });
  }
  const user = await getSessionUser(request);
  if (!user) throw loginRedirect(request);
  const form = await request.formData();
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : null;
  };
  const { app } = await reviewTarget(request, String(field('app') ?? ''));
  const ctx = contextOf(field);
  const body = String(field('body') ?? '');
  try {
    const note = await createFeedback(
      { appId: app.id, authorUserId: user.id, versionNumber: ctx.version, path: ctx.path, anchor: ctx.anchor, body },
      { limits: feedbackLimits() }
    );
    return data<FeedbackActionResult>({ ok: true, id: note.id });
  } catch (err) {
    if (!(err instanceof AppsError)) throw err;
    if (err.code === 'rate_limited') {
      return data<FeedbackActionResult>(
        { ok: false, error: err.message, body },
        { status: 429, headers: { 'Retry-After': String(err.details?.retry_after_seconds ?? 3600) } }
      );
    }
    if (err.code === 'limit_exceeded') return data<FeedbackActionResult>({ ok: false, error: err.message, body }, { status: 409 });
    if (err.code === 'invalid_settings') return data<FeedbackActionResult>({ ok: false, error: err.message, body }, { status: 400 });
    if (err.code === 'not_found') notFound();
    throw err;
  }
}
