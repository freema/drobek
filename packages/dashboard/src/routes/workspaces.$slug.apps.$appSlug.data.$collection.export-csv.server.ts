/**
 * GET /workspaces/:slug/apps/:appSlug/data/:collection/export.csv — the CSV
 * export (M1b, PHY-121). Streams the collection (the CURRENT filter/sort applied)
 * as text/csv, columns = the required-schema properties, RFC-4180 escaping. A
 * resource route (no component) returning a streaming Response.
 *
 * Isolation + authz: requireWorkspaceRole('viewer') requires a member of THIS
 * workspace (unknown slug / non-member → 404), and getCollectionForMember +
 * iterateRecordsForMember resolve the app under that workspace (a cross-workspace
 * app → 404). Memory is bounded — records are pulled a keyset page at a time and
 * written to the stream, never buffered whole.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { DataError } from '@drobek/data';
import {
  csvHeader,
  csvRow,
  getCollectionForMember,
  iterateRecordsForMember,
  mapFilterSort,
  schemaColumns,
} from '@drobek/data';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { parseDataQuery } from './workspaces.$slug.apps.$appSlug.data.$collection.server.js';

function statusFor(err: unknown): number {
  if (err instanceof DataError) {
    if (err.code === 'not_found') return 404;
    if (err.code === 'forbidden') return 403;
  }
  return 500;
}

export async function loader({
  request,
  params,
}: LoaderFunctionArgs): Promise<Response> {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'viewer'
  );
  const appSlug = String(params.appSlug ?? '');
  const collection = String(params.collection ?? '');
  const q = parseDataQuery(new URL(request.url));

  const ctx = {
    wsSlug: access.workspace.slug,
    appSlug,
    workspaceId: access.workspace.id,
    role: access.effectiveRole,
  };

  // Resolve + authorize + read the schema BEFORE streaming so an access/not-found
  // error maps to a clean HTTP status (not a torn stream).
  let columns;
  let filter;
  try {
    const meta = await getCollectionForMember(ctx, collection);
    columns = schemaColumns(meta.jsonSchema);
    filter = mapFilterSort({
      filterField: q.field,
      filterValue: q.value,
      sortField: q.sortField,
      dir: q.dir,
      columns,
    });
  } catch (err) {
    return new Response('export unavailable\n', {
      status: statusFor(err),
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const cols = columns;
  const where = filter.where;
  const sort = filter.sort;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(`${csvHeader(cols)}\r\n`));
        for await (const page of iterateRecordsForMember(ctx, collection, {
          where,
          sort,
        })) {
          let chunk = '';
          for (const rec of page) chunk += `${csvRow(rec.doc, cols)}\r\n`;
          if (chunk) controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const filename = `${appSlug}-${collection}.csv`.replace(/[^a-zA-Z0-9._-]/g, '_');
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
