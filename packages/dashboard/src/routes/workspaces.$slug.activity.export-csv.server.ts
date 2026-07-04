/**
 * GET /workspaces/:slug/activity/export.csv — the Activity (audit) CSV export
 * (PHY-85). Streams the workspace's audit trail (the SAME app + action filter the
 * table applies) as text/csv, RFC-4180 escaped (shared csvLine primitive, PHY-121).
 * A resource route (no component) returning a streaming Response.
 *
 * Authz + isolation: requireWorkspaceRole('workspace-admin') — admin/super-admin
 * ONLY (viewer/editor → 403, non-member → 404, anonymous → /login), and
 * listActivity is workspace-scoped, so the export can only ever contain THIS
 * workspace's rows. Memory is bounded: rows are pulled a keyset page at a time and
 * written to the stream, never buffered whole. Events for a deleted app still
 * export (the subject is plain text, no join to `apps`).
 */
import { type LoaderFunctionArgs } from 'react-router';
import { listActivity } from '@drobek/audit';
import { requireWorkspaceRole } from '@drobek/tenancy';
import {
  activityCsvHeaderLine,
  activityCsvRowLine,
} from '../activity-csv.server.js';
import { parseActivityQuery } from './workspaces.$slug.activity.server.js';

const EXPORT_PAGE_SIZE = 200;

export async function loader({
  request,
  params,
}: LoaderFunctionArgs): Promise<Response> {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'workspace-admin'
  );
  const q = parseActivityQuery(new URL(request.url));
  const workspaceId = access.workspace.id;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(`${activityCsvHeaderLine()}\r\n`));
        let cursor: string | null = null;
        do {
          const result = await listActivity({
            workspaceId,
            action: q.action,
            subject: q.app,
            cursor,
            limit: EXPORT_PAGE_SIZE,
          });
          let chunk = '';
          for (const r of result.rows) {
            chunk += `${activityCsvRowLine({
              createdAt: r.createdAt.toISOString(),
              action: r.action,
              actorKind: r.actorKind,
              actor: r.actorEmail ?? '',
              subjectType: r.subjectType,
              subject: r.target,
            })}\r\n`;
          }
          if (chunk) controller.enqueue(encoder.encode(chunk));
          cursor = result.nextCursor;
        } while (cursor);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const filename = `${access.workspace.slug}-activity.csv`.replace(
    /[^a-zA-Z0-9._-]/g,
    '_'
  );
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
