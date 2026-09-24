/**
 * GET /workspaces/:slug/apps/:appSlug/data/:collection/export.csv — the CSV
 * export of the Data tab (the CURRENT filter/sort applied). Columns: `_id`,
 * `_owner`, `_created_at`, `_updated_at`, then the schema's properties (every
 * key of the records for a schemaless collection). Every cell is escaped by
 * the data module (RFC 4180, spreadsheet formulas neutralized). A resource
 * route (no component) returning a streaming Response.
 *
 * Isolation + authz: requireWorkspaceRole('viewer') requires a member of THIS
 * workspace (unknown slug / non-member → 404), and recordsOf resolves the app
 * under that workspace (another workspace's app → 404). Memory is bounded —
 * the module pulls one keyset page at a time.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { csvChunks, isModuleError } from '@drobek/modules';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { mapFilterSort } from '../data-view.js';
import { recordsOf } from './data-http.server.js';
import { parseDataQuery } from './workspaces.$slug.apps.$appSlug.data.$collection.server.js';

function unavailable(status: number): Response {
  return new Response('export unavailable\n', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<Response> {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const appSlug = String(params.appSlug ?? '');
  const collection = String(params.collection ?? '');
  const q = parseDataQuery(new URL(request.url));
  const records = await recordsOf(access.workspace.id, appSlug);

  // Resolve the collection BEFORE streaming so a not-found maps to a clean
  // HTTP status (not a torn stream).
  const meta = (await records.collections()).find((c) => c.name === collection);
  if (!meta) return unavailable(404);
  const fs = mapFilterSort({ filterField: q.field, filterValue: q.value, sortField: q.sortField, dir: q.dir, columns: meta.columns });
  let lines: AsyncIterator<string>;
  let first: IteratorResult<string>;
  try {
    lines = records.csv({ collection, filter: fs.filter, sort: fs.sort, dir: fs.dir })[Symbol.asyncIterator]();
    first = await lines.next();
  } catch (err) {
    return unavailable(isModuleError(err) && err.code === 'not_found' ? 404 : isModuleError(err) ? 400 : 500);
  }

  async function* all(): AsyncGenerator<string> {
    if (!first.done) yield first.value;
    for (let r = await lines.next(); !r.done; r = await lines.next()) yield r.value;
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // The same ~64 KiB chunks as the app host's export.csv (csvChunks).
        for await (const chunk of csvChunks(all())) controller.enqueue(encoder.encode(chunk));
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
