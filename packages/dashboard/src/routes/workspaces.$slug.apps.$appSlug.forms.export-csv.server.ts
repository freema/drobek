/**
 * GET /workspaces/:slug/apps/:appSlug/forms/export.csv — the Forms tab's CSV
 * export (the CURRENT form + date filter): `id, form, created_at` + every
 * field name, newest first, ≤ 10 000 rows, every cell through `csvLine`
 * (spreadsheet formulas neutralized — submissions are visitor input). viewer+;
 * another workspace's app → 404. Audit `forms.export` (form + row count, never
 * values) like the module's own export.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { AUDIT_ACTIONS } from '@drobek/audit';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { auditOwner, ownerApp, ownerError, submissionsOf } from '../owner-http.server.js';
import { dayRange } from '../owner-view.js';
import { parseFormsFilter } from './workspaces.$slug.apps.$appSlug.forms.server.js';

function plain(status: number, text: string): Response {
  return new Response(`${text}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<Response> {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const subs = await submissionsOf(app);
  if (!subs) return plain(404, 'export unavailable');
  const f = parseFormsFilter(new URL(request.url));

  const lines: string[] = [];
  try {
    for await (const line of subs.csv({ form: f.form || undefined, ...dayRange(f.from, f.to) })) lines.push(line);
  } catch (err) {
    const e = ownerError(err);
    return plain(e.status, e.message);
  }
  await auditOwner(access, app, AUDIT_ACTIONS.formsExport, { module: subs.module, form: f.form || null, rows: Math.max(0, lines.length - 1) });

  const filename = `${app.slug}-${f.form || 'forms'}-submissions.csv`.replace(/[^a-zA-Z0-9._-]/g, '_');
  return new Response(`${lines.join('\r\n')}\r\n`, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
