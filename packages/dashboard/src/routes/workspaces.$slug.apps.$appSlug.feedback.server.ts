/**
 * GET/POST /workspaces/:slug/apps/:appSlug/feedback — server half of the
 * Feedback tab: the notes members left on the app's preview (the widget's
 * /feedback/new page), the same @drobek/apps functions as list_feedback and
 * resolve_feedback.
 *
 * GET (viewer+): `?status=open|resolved|all` (default open), one page
 * (FEEDBACK_TAB_PAGE, newest first, `?before=<id>`), the open and resolved
 * counts; a page that cannot be read (a stale cursor) shows its error with the
 * filter intact. `?confirm=<id>` opens the delete confirmation.
 *
 * POST: `intent=resolve` (with an optional `note`) and `intent=reopen` need
 * editor+; `intent=delete` the note's author or a workspace admin. Each change
 * is audited by @drobek/apps; the redirect keeps the filter.
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import {
  AppsError,
  FEEDBACK_RESOLUTION_NOTE_MAX,
  feedbackCounts,
  getFeedback,
  isFeedbackId,
  listFeedback,
  mayDeleteFeedback,
  parseFeedbackFilter,
  previewUrl,
  setFeedbackResolved,
  versionUrl,
  deleteFeedback,
  type Actor,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { requireWorkspaceRole, roleAtLeast } from '@drobek/tenancy';
import { appHeaderFor } from '../app-page.server.js';
import { anchorText, noteOpenUrl } from '../feedback-view.js';
import { ownerApp } from '../owner-http.server.js';

export const FEEDBACK_TAB_PAGE = 25;

function filterSearch(status: string, extra: Record<string, string> = {}): string {
  const sp = new URLSearchParams();
  if (status !== 'open') sp.set('status', status);
  for (const [k, v] of Object.entries(extra)) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const url = new URL(request.url);
  const status = parseFeedbackFilter(url.searchParams.get('status'));
  const beforeRaw = url.searchParams.get('before');
  const before = isFeedbackId(beforeRaw) ? beforeRaw : null;
  const confirm = url.searchParams.get('confirm') ?? '';
  const counts = (await feedbackCounts([app.id])).get(app.id) ?? { open: 0, resolved: 0 };
  const base = {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    appSlug: app.slug,
    /** The app header + tabs on every app sub-page. */
    header: await appHeaderFor(access, app.slug),
    status,
    counts,
    previewUrl: previewUrl(app.slug),
    canResolve: roleAtLeast(access.effectiveRole, 'editor'),
    noteMax: FEEDBACK_RESOLUTION_NOTE_MAX,
    confirmId: isFeedbackId(confirm) ? confirm : '',
    paged: before !== null,
  };
  try {
    const page = await listFeedback(app.id, { status, before, limit: FEEDBACK_TAB_PAGE });
    return {
      ...base,
      rows: page.notes.map((n) => ({
        id: n.id,
        body: n.body,
        author: n.authorEmail,
        createdAt: n.createdAt.toISOString(),
        version: n.versionNumber,
        path: n.path,
        spot: anchorText(n.anchor),
        openUrl: noteOpenUrl(n, { preview: previewUrl(app.slug), version: (v) => versionUrl(app.slug, v) }),
        status: n.status,
        resolvedAt: n.resolvedAt?.toISOString() ?? null,
        resolvedBy: n.resolvedByEmail,
        resolvedByAgent: n.resolvedByKind === 'agent',
        resolutionNote: n.resolutionNote,
        canDelete: mayDeleteFeedback(n, { userId: access.user.id, role: access.effectiveRole }),
      })),
      nextBefore: page.nextBefore ? filterSearch(status, { before: page.nextBefore }) : null,
      error: null as string | null,
    };
  } catch (err) {
    if (!(err instanceof AppsError) || err.code !== 'not_found') throw err;
    return { ...base, rows: [], nextBefore: null, error: err.message };
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const id = String(form.get('id') ?? '');
  const status = parseFeedbackFilter(form.get('status'));
  if (!isFeedbackId(id)) return data({ error: 'That note does not exist any more — reload the page.' }, { status: 400 });
  const actor: Actor = { userId: access.user.id, kind: actorKindForSurface('web') };
  const back = () => redirect(`/workspaces/${access.workspace.slug}/apps/${app.slug}/feedback${filterSearch(status)}`);

  if (intent === 'resolve' || intent === 'reopen') {
    if (!roleAtLeast(access.effectiveRole, 'editor')) {
      return data({ error: 'Resolving and reopening notes needs the editor role in this workspace.' }, { status: 403 });
    }
    try {
      await setFeedbackResolved(app.id, id, intent === 'resolve', actor, { note: form.get('note') ?? undefined });
    } catch (err) {
      if (err instanceof AppsError && (err.code === 'not_found' || err.code === 'invalid_settings')) {
        return data({ error: err.message }, { status: err.code === 'not_found' ? 404 : 400 });
      }
      throw err;
    }
    return back();
  }
  if (intent === 'delete') {
    const note = await getFeedback(app.id, id);
    if (!note) return data({ error: 'That note does not exist any more — reload the page.' }, { status: 404 });
    if (!mayDeleteFeedback(note, { userId: access.user.id, role: access.effectiveRole })) {
      return data({ error: 'Only the note’s author or a workspace admin can delete it.' }, { status: 403 });
    }
    await deleteFeedback(app.id, id, actor);
    return back();
  }
  return data({ error: 'Unsupported action.' }, { status: 400 });
}
