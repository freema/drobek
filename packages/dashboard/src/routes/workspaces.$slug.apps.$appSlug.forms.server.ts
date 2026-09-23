/**
 * GET/POST /workspaces/:slug/apps/:appSlug/forms — server half of the Forms
 * tab (M2-03): the app's stored form submissions, through the forms module's
 * `submissions` authority (the owner's view; the per-form `admin` rule of the
 * app host does not apply to workspace members).
 *
 * GET (viewer+): the app's forms with their counts, one page (25, newest
 * first, keyset) filtered by form and an inclusive UTC day range
 * (`from`/`to` = YYYY-MM-DD), the total; `?confirm=<id>` opens the delete
 * confirmation of one submission.
 *
 * POST (editor+): `intent=delete` → the submission is deleted (audit
 * `forms.submission_delete`, the id only), back to the same filter.
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { AUDIT_ACTIONS } from '@drobek/audit';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { auditOwner, ownerApp, ownerError, submissionsOf } from '../owner-http.server.js';
import { dayRange, parseDay, submissionFields } from '../owner-view.js';

export const SUBMISSIONS_PAGE = 25;

export interface FormsFilter {
  form: string;
  from: string;
  to: string;
}

const FORM_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function parseFormsFilter(url: URL): FormsFilter & { cursor: string; confirm: string } {
  const p = url.searchParams;
  const form = (p.get('form') ?? '').trim();
  return {
    form: FORM_RE.test(form) ? form : '',
    from: parseDay(p.get('from')),
    to: parseDay(p.get('to')),
    cursor: (p.get('cursor') ?? '').slice(0, 512),
    confirm: (p.get('confirm') ?? '').trim().slice(0, 64),
  };
}

/** The filter as a query string (no cursor/confirm) — for links, the CSV export and redirects. */
export function formsSearch(f: FormsFilter): string {
  const sp = new URLSearchParams();
  if (f.form) sp.set('form', f.form);
  if (f.from) sp.set('from', f.from);
  if (f.to) sp.set('to', f.to);
  return sp.toString();
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const f = parseFormsFilter(new URL(request.url));
  const base = {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    appSlug: app.slug,
    filter: { form: f.form, from: f.from, to: f.to },
    search: formsSearch(f),
    confirmId: f.confirm,
    canDelete: access.effectiveRole !== 'viewer',
  };
  const subs = await submissionsOf(app);
  if (!subs) return { ...base, enabled: false as const, forms: [], rows: [], total: 0, nextCursor: null, error: null };

  const forms = await subs.forms();
  try {
    const page = await subs.list({ form: f.form || undefined, ...dayRange(f.from, f.to), limit: SUBMISSIONS_PAGE, cursor: f.cursor || null });
    return {
      ...base,
      enabled: true as const,
      forms,
      rows: page.submissions.map((s) => ({
        id: s.id,
        form: s.form,
        createdAt: s.created_at,
        userId: s.user_id,
        notified: s.notified,
        fields: submissionFields(s.data),
      })),
      total: page.total,
      nextCursor: page.next_cursor,
      error: null,
    };
  } catch (err) {
    // A stale/forged cursor: show the first page's controls with the message.
    return { ...base, enabled: true as const, forms, rows: [], total: 0, nextCursor: null, error: ownerError(err).message };
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'editor');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const form = await request.formData();
  if (String(form.get('intent') ?? '') !== 'delete') return data({ error: 'Unsupported action.' }, { status: 400 });
  const id = String(form.get('id') ?? '').trim();
  if (!/^fs_[0-9a-f]{24}$/.test(id)) return data({ error: 'Missing submission id.' }, { status: 400 });
  const subs = await submissionsOf(app);
  if (!subs) throw data({ message: 'Not found' }, { status: 404 });
  if (!(await subs.remove(id))) throw data({ message: 'Not found' }, { status: 404 });
  await auditOwner(access, app, AUDIT_ACTIONS.formsSubmissionDelete, { module: subs.module, submission: id });

  const search = formsSearch({
    form: FORM_RE.test(String(form.get('form') ?? '')) ? String(form.get('form')) : '',
    from: parseDay(String(form.get('from') ?? '')),
    to: parseDay(String(form.get('to') ?? '')),
  });
  return redirect(`/workspaces/${access.workspace.slug}/apps/${app.slug}/forms${search ? `?${search}` : ''}`);
}
