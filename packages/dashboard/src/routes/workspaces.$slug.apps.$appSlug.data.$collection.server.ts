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
 * POST (editor+), by `intent` — requireWorkspaceRole('editor') gates every
 * one SERVER-SIDE (a viewer gets 403, a non-member 404) before anything
 * changes, and each is audited (actor: the dashboard user; ids and counts,
 * never values):
 *   - `delete`          one record (permanently)           → data.record_delete
 *   - `update`          replace a record's fields (the JSON editor, `?edit=<id>`),
 *                       validated by the data module (schema, quotas) → data.record_update
 *   - `import`          a CSV file (multipart, ≤ IMPORT_MAX_BYTES, ≤ 5 000 rows):
 *                       all or nothing — the first bad row is reported with
 *                       its line, nothing stored; the owner's import skips the
 *                       app's write rate limit, never the quota  → data.import
 *   - `drop-collection` delete the collection (records + declaration) after
 *                       the owner typed its name (`?drop=1`)    → data.collection_delete
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { AUDIT_ACTIONS } from '@drobek/audit';
import { RECORDS_IMPORT_MAX_ROWS } from '@drobek/modules';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { flattenRecord, mapFilterSort, rulesText, type Column } from '../data-view.js';
import { auditOwner, ownerError } from '../owner-http.server.js';
import { IMPORT_MAX_BYTES, editableJson, parseRecordJson } from '../owner-view.js';
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
  edit: string;
  drop: boolean;
  imported: string;
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
    edit: (p.get('edit') ?? '').trim(),
    drop: p.get('drop') === '1',
    imported: /^\d{1,6}$/.test(p.get('imported') ?? '') ? String(p.get('imported')) : '',
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

    // The JSON editor for one record (editor+), if requested + still there.
    let editRecord: { id: string; json: string } | null = null;
    if (q.edit && access.effectiveRole !== 'viewer') {
      const rec = await records.get(collection, q.edit).catch(() => null);
      if (rec) editRecord = { id: String(rec._id), json: editableJson(rec) };
    }

    return {
      workspace: { slug: access.workspace.slug, name: access.workspace.name },
      appSlug,
      collection: {
        name: meta.name,
        rules: rulesText(meta.rules),
        schemaless: meta.schema === null,
        records: meta.records,
      },
      editRecord,
      dropOpen: q.drop && access.effectiveRole !== 'viewer',
      imported: q.imported ? Number(q.imported) : null,
      importMaxRows: RECORDS_IMPORT_MAX_ROWS,
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

type ActionIntent = 'delete' | 'update' | 'import' | 'drop-collection';

function actionError(intent: ActionIntent, status: number, error: string, extra: Record<string, string> = {}) {
  return data({ intent, error, ...extra }, { status });
}

export async function action({ request, params }: ActionFunctionArgs) {
  // Editor GATE (server-side): viewer → 403, non-member → 404, anonymous →
  // /login — thrown here BEFORE anything changes.
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'editor'
  );
  const appSlug = String(params.appSlug ?? '');
  const collection = String(params.collection ?? '');
  const collBase = `/workspaces/${access.workspace.slug}/apps/${appSlug}/data/${collection}`;

  // A CSV import is the only large body: refuse it before it is read.
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > IMPORT_MAX_BYTES + 64 * 1024) {
    return actionError('import', 413, `The file is larger than ${IMPORT_MAX_BYTES / (1024 * 1024)} MiB — split it into smaller files.`);
  }
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '') as ActionIntent;
  const records = await recordsOf(access.workspace.id, appSlug);
  const audit = (action: string, meta: Record<string, unknown>) => auditOwner(access, { slug: appSlug }, action, { module: records.module, collection, ...meta });

  if (intent === 'delete') {
    const id = String(form.get('id') ?? '').trim();
    if (!id) return actionError(intent, 400, 'Missing record id.');
    const removed = await withDataErrors(() => records.remove(collection, id));
    if (!removed) throw data({ message: 'Not found' }, { status: 404 });
    await audit(AUDIT_ACTIONS.dataRecordDelete, { id });
    // Back to the table, preserving the active filter/sort (drop cursor → page 1).
    const search = baseSearch({
      field: String(form.get('field') ?? ''),
      value: String(form.get('value') ?? ''),
      sortField: String(form.get('sort') ?? ''),
      dir: String(form.get('dir') ?? ''),
    });
    return redirect(`${collBase}${search ? `?${search}` : ''}`);
  }

  if (intent === 'update') {
    const id = String(form.get('id') ?? '').trim();
    const json = String(form.get('json') ?? '');
    if (!id) return actionError(intent, 400, 'Missing record id.');
    const parsed = parseRecordJson(json);
    if (!parsed.ok) return actionError(intent, 400, parsed.error, { id, json });
    let updated: Record<string, unknown> | null;
    try {
      updated = await records.update(collection, id, parsed.fields);
    } catch (err) {
      const e = ownerError(err);
      if (e.status === 404) throw data({ message: 'Not found' }, { status: 404 });
      return actionError(intent, e.status, e.message, { id, json });
    }
    if (!updated) throw data({ message: 'Not found' }, { status: 404 });
    await audit(AUDIT_ACTIONS.dataRecordUpdate, { id });
    return redirect(`${collBase}?record=${encodeURIComponent(id)}`);
  }

  if (intent === 'import') {
    const file = form.get('file');
    if (!file || typeof file === 'string' || file.size === 0) return actionError(intent, 400, 'Choose a CSV file to import.');
    if (file.size > IMPORT_MAX_BYTES) {
      return actionError(intent, 413, `The file is larger than ${IMPORT_MAX_BYTES / (1024 * 1024)} MiB — split it into smaller files.`);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      return actionError(intent, 400, 'The file is not UTF-8 text. Save the CSV as UTF-8 and try again.');
    }
    let imported: number;
    try {
      imported = (await records.importCsv(collection, text)).imported;
    } catch (err) {
      const e = ownerError(err);
      if (e.status === 404) throw data({ message: 'Not found' }, { status: 404 });
      return actionError(intent, e.status, e.message);
    }
    await audit(AUDIT_ACTIONS.dataImport, { rows: imported });
    return redirect(`${collBase}?imported=${imported}`);
  }

  if (intent === 'drop-collection') {
    const typed = String(form.get('confirm_name') ?? '').trim();
    if (typed !== collection) {
      return actionError(intent, 400, `Type the collection name "${collection}" to confirm.`);
    }
    try {
      await records.dropCollection(collection, access.user.id);
    } catch (err) {
      const e = ownerError(err);
      if (e.status === 404) throw data({ message: 'Not found' }, { status: 404 });
      return actionError(intent, e.status, e.message);
    }
    return redirect(`/workspaces/${access.workspace.slug}/apps/${appSlug}/data?dropped=${encodeURIComponent(collection)}`);
  }

  return actionError('delete', 400, 'Unsupported action.');
}
