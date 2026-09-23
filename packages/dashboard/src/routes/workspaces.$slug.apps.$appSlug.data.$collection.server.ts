/**
 * GET/POST /workspaces/:slug/apps/:appSlug/data/:collection — server half. The
 * collection TABLE view (the owner's view through the data module's records
 * authority; the end-user rules do not apply to workspace members).
 *
 * GET (viewer+): records flattened to the schema's columns (required first),
 * newest first, with a field FILTER + a SORT passed to the records query
 * (unknown fields are dropped by mapFilterSort before they reach it). Keyset
 * pagination via an opaque cursor. A `?record=<id>` opens a read-only JSON
 * viewer for one record.
 *
 * POST (editor+): the DELETE action. requireWorkspaceRole('editor') gates it
 * SERVER-SIDE — a viewer gets 403, a non-member 404 — before the record is
 * deleted (permanently).
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { flattenRecord, mapFilterSort, rulesText, type Column } from '../data-view.js';
import { recordsOf, withDataErrors } from './data-http.server.js';

/** Rows per page (keyset). Small: the LITE Data tab is for spot-checking. */
export const PAGE_SIZE = 25;

export interface DataQuery {
  field: string;
  value: string;
  sortField: string;
  dir: 'asc' | 'desc';
  cursor: string;
  record: string;
  confirm: string;
}

/** Parse the dashboard's Data-table query params off a request URL. */
export function parseDataQuery(url: URL): DataQuery {
  const p = url.searchParams;
  return {
    field: (p.get('field') ?? '').trim(),
    value: p.get('value') ?? '',
    sortField: (p.get('sort') ?? '').trim(),
    dir: p.get('dir') === 'asc' ? 'asc' : 'desc',
    cursor: p.get('cursor') ?? '',
    record: (p.get('record') ?? '').trim(),
    confirm: (p.get('confirm') ?? '').trim(),
  };
}

/** The filter+sort query string (no cursor/record/confirm) — for links/redirects. */
export function baseSearch(q: {
  field: string;
  value: string;
  sortField: string;
  dir: string;
}): string {
  const sp = new URLSearchParams();
  if (q.field) {
    sp.set('field', q.field);
    sp.set('value', q.value);
  }
  if (q.sortField) {
    sp.set('sort', q.sortField);
    sp.set('dir', q.dir);
  }
  return sp.toString();
}

export interface DataTableRow {
  id: string;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
  cells: string[];
  hasExtra: boolean;
  extraJson: string | null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'viewer'
  );
  const appSlug = String(params.appSlug ?? '');
  const collection = String(params.collection ?? '');
  const q = parseDataQuery(new URL(request.url));
  const records = await recordsOf(access.workspace.id, appSlug);

  return withDataErrors(async () => {
    const meta = (await records.collections()).find((c) => c.name === collection);
    if (!meta) throw data({ message: 'Not found' }, { status: 404 });
    const columns: Column[] = meta.columns;

    // Map the (whitelisted) filter + sort; an unknown field is dropped by
    // mapFilterSort before it reaches the query (never 500s the page).
    const fs = mapFilterSort({
      filterField: q.field,
      filterValue: q.value,
      sortField: q.sortField,
      dir: q.dir,
      columns,
    });
    const page = await records.query({
      collection,
      filter: fs.filter,
      sort: fs.sort,
      dir: fs.dir,
      limit: PAGE_SIZE,
      cursor: q.cursor || null,
    });

    const rows: DataTableRow[] = page.records.map((r) => {
      const flat = flattenRecord(r, columns);
      return {
        id: String(r._id),
        owner: r._owner == null ? null : String(r._owner),
        createdAt: String(r._created_at),
        updatedAt: String(r._updated_at),
        cells: flat.cells,
        hasExtra: flat.hasExtra,
        extraJson: flat.hasExtra ? JSON.stringify(flat.extra, null, 2) : null,
      };
    });

    // The read-only record viewer (modal), if requested + still there.
    let openRecord: {
      id: string;
      createdAt: string;
      updatedAt: string;
      json: string;
    } | null = null;
    if (q.record) {
      const rec = await records.get(collection, q.record).catch(() => null);
      if (rec) {
        openRecord = {
          id: String(rec._id),
          createdAt: String(rec._created_at),
          updatedAt: String(rec._updated_at),
          json: JSON.stringify(rec, null, 2),
        };
      }
    }

    return {
      workspace: { slug: access.workspace.slug, name: access.workspace.name },
      appSlug,
      collection: {
        name: meta.name,
        rules: rulesText(meta.rules),
        schemaless: meta.schema === null,
      },
      columns,
      rows,
      total: page.total,
      nextCursor: page.next_cursor,
      query: {
        field: q.field,
        value: q.value,
        sortField: q.sortField,
        dir: q.dir,
      },
      baseSearch: baseSearch({
        field: q.field,
        value: q.value,
        sortField: q.sortField,
        dir: q.dir,
      }),
      confirmId: q.confirm,
      openRecord,
      canDelete: access.effectiveRole !== 'viewer',
      role: access.effectiveRole,
    };
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  // Delete GATE: editor+ (server-side). viewer → 403, non-member → 404,
  // anonymous → /login — thrown here BEFORE the delete runs.
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'editor'
  );
  const appSlug = String(params.appSlug ?? '');
  const collection = String(params.collection ?? '');
  const form = await request.formData();

  if (String(form.get('intent') ?? '') !== 'delete') {
    return data({ error: 'Unsupported action.' }, { status: 400 });
  }
  const id = String(form.get('id') ?? '').trim();
  if (!id) {
    return data({ error: 'Missing record id.' }, { status: 400 });
  }

  const records = await recordsOf(access.workspace.id, appSlug);
  const removed = await withDataErrors(() => records.remove(collection, id));
  if (!removed) throw data({ message: 'Not found' }, { status: 404 });

  // Back to the table, preserving the active filter/sort (drop cursor → page 1).
  const search = baseSearch({
    field: String(form.get('field') ?? ''),
    value: String(form.get('value') ?? ''),
    sortField: String(form.get('sort') ?? ''),
    dir: String(form.get('dir') ?? ''),
  });
  const suffix = search ? `?${search}` : '';
  return redirect(
    `/workspaces/${access.workspace.slug}/apps/${appSlug}/data/${collection}${suffix}`
  );
}
