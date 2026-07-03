/**
 * GET/POST /workspaces/:slug/apps/:appSlug/data/:collection — server half (M1b,
 * PHY-121). The collection TABLE view.
 *
 * GET (viewer+): rows flattened to the required-schema columns (schema order),
 * newest-first, with a field FILTER + a SORT passed THROUGH to the U10 query API
 * (queryRecordsForMember → the same whitelisted query builder — unknown fields
 * are dropped by mapFilterSort before they reach it). Keyset pagination via an
 * opaque cursor. A `?record=<id>` opens a read-only JSON viewer for one record.
 *
 * POST (editor+): the DELETE action. requireWorkspaceRole('editor') gates it
 * SERVER-SIDE — a viewer gets 403, a non-member 404 — before the soft-delete
 * (deleteRecordForMember, editor+). The member-view path (NOT the anon
 * access-mode gate) authorizes both: a workspace member may read/delete data in
 * ANY of their app's collections regardless of access_mode.
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import {
  deleteRecordForMember,
  getCollectionForMember,
  mapFilterSort,
  queryRecordsForMember,
  readRecordForMember,
  flattenDoc,
  schemaColumns,
  type SchemaColumn,
} from '@drobek/data';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { withDataErrors } from './data-http.server.js';

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

  const ctx = {
    wsSlug: access.workspace.slug,
    appSlug,
    workspaceId: access.workspace.id,
    role: access.effectiveRole,
  };

  return withDataErrors(async () => {
    // Collection schema → the ordered display columns (member-gated: viewer+).
    const meta = await getCollectionForMember(ctx, collection);
    const columns: SchemaColumn[] = schemaColumns(meta.jsonSchema);

    // Map the (whitelisted) filter + sort, then query with them applied THROUGH
    // to the U10 query API. An unknown filter/sort field is dropped by
    // mapFilterSort before it reaches the whitelist (never 500s the page).
    const fs = mapFilterSort({
      filterField: q.field,
      filterValue: q.value,
      sortField: q.sortField,
      dir: q.dir,
      columns,
    });
    const applied = await queryRecordsForMember(ctx, collection, {
      where: fs.where,
      sort: fs.sort,
      limit: PAGE_SIZE,
      cursor: q.cursor || undefined,
    });

    const rows: DataTableRow[] = applied.result.records.map((r) => {
      const flat = flattenDoc(r.doc, columns);
      return {
        id: r.id,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        cells: flat.cells,
        hasExtra: flat.hasExtra,
        extraJson: flat.hasExtra ? JSON.stringify(flat.extra, null, 2) : null,
      };
    });

    // The read-only record viewer (modal), if requested + still live.
    let openRecord: {
      id: string;
      createdAt: string;
      updatedAt: string;
      json: string;
    } | null = null;
    if (q.record) {
      try {
        const rec = await readRecordForMember(ctx, collection, q.record);
        openRecord = {
          id: rec.id,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          json: JSON.stringify(rec.doc, null, 2),
        };
      } catch {
        openRecord = null; // deleted/unknown → just don't open the viewer.
      }
    }

    return {
      workspace: { slug: access.workspace.slug, name: access.workspace.name },
      appSlug,
      collection: {
        name: meta.name,
        accessMode: meta.accessMode,
      },
      columns,
      rows,
      nextCursor: applied.result.nextCursor,
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
  // anonymous → /login — thrown here BEFORE the soft-delete runs.
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

  await withDataErrors(() =>
    deleteRecordForMember(
      {
        wsSlug: access.workspace.slug,
        appSlug,
        workspaceId: access.workspace.id,
        role: access.effectiveRole,
      },
      collection,
      id
    )
  );

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
