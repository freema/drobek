/**
 * The OWNER's view of the stored submissions (the `submissions` authority —
 * the dashboard Forms tab, M2-03). Core calls it only after it authorized a
 * drobek account for the app, so it bypasses the per-form `admin` rule of
 * the REST routes; every query is still scoped to the ONE app of its view.
 *
 *   forms  — declared forms + forms with stored submissions, with counts
 *   list   — newest first, a form filter and a [from, to) date range, keyset
 *   csv    — the same filter, ≤ CSV_MAX_ROWS rows, through `csvLine`
 *   remove — one submission
 */
import { and, count, desc, eq, gte, lt, or, type SQL } from 'drizzle-orm';
import { csvLine } from '@drobek/core';
import { ModuleError, type OwnerSubmission, type SubmissionsAuthority, type SubmissionsQuery } from '@drobek/modules';
import { FORM_NAME_RE, type FormsConfig } from './config.js';
import { fieldText } from './fields.js';
import { CSV_MAX_ROWS } from './routes.js';
import { formSubmissions, type FieldValue, type FormSubmissionRow } from './schema.js';
import { decodeCursor, encodeCursor } from './submissions.js';

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

function bad(message: string, path: string): ModuleError {
  return new ModuleError('invalid_request', message, { details: [{ path, message }] });
}

function instant(raw: string | undefined, path: string): Date | null {
  if (raw === undefined || raw === '') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw bad(`\`${path}\` is not a date/time`, path);
  return d;
}

/** The WHERE of a filter (always the app first). */
function whereOf(appId: string, q: Omit<SubmissionsQuery, 'limit' | 'cursor'>): SQL {
  const conds: SQL[] = [eq(formSubmissions.appId, appId)];
  if (q.form !== undefined && q.form !== '') {
    if (!FORM_NAME_RE.test(q.form)) throw bad('`form` is not a form name', 'form');
    conds.push(eq(formSubmissions.form, q.form));
  }
  const from = instant(q.from, 'from');
  const to = instant(q.to, 'to');
  if (from) conds.push(gte(formSubmissions.createdAt, from));
  if (to) conds.push(lt(formSubmissions.createdAt, to));
  return and(...conds)!;
}

export function ownerSubmission(row: FormSubmissionRow): OwnerSubmission {
  return {
    id: row.id,
    form: row.form,
    created_at: row.createdAt.toISOString(),
    data: row.data,
    user_id: row.userId,
    notified: row.notifiedAt !== null,
  };
}

/** The CSV of stored rows: `id, form, created_at` + every field name (sorted — jsonb does not keep key order). */
export function submissionsCsv(rows: FormSubmissionRow[]): string[] {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row.data)))].sort();
  const own = (data: Record<string, FieldValue>, k: string) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : undefined);
  return [
    csvLine(['id', 'form', 'created_at', ...columns]),
    ...rows.map((row) => csvLine([row.id, row.form, row.createdAt.toISOString(), ...columns.map((k) => fieldText(own(row.data, k)))])),
  ];
}

export const submissionsAuthority: SubmissionsAuthority<FormsConfig> = {
  async forms(view) {
    const rows = await view.db
      .select({ form: formSubmissions.form, n: count() })
      .from(formSubmissions)
      .where(eq(formSubmissions.appId, view.app.id))
      .groupBy(formSubmissions.form);
    const counts = new Map(rows.map((r) => [r.form, Number(r.n)]));
    const names = new Set([...Object.keys(view.config.forms), ...counts.keys()]);
    return [...names].sort().map((name) => ({ name, submissions: counts.get(name) ?? 0 }));
  },

  async list(view, q) {
    const where = whereOf(view.app.id, q);
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(q.limit ?? DEFAULT_PAGE)) || DEFAULT_PAGE));
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) throw bad('the cursor is not valid — use next_cursor of the previous page', 'cursor');
    const page = cursor
      ? and(
          where,
          or(
            lt(formSubmissions.createdAt, cursor.createdAt),
            and(eq(formSubmissions.createdAt, cursor.createdAt), lt(formSubmissions.id, cursor.id))
          )
        )
      : where;
    const rows = await view.db
      .select()
      .from(formSubmissions)
      .where(page)
      .orderBy(desc(formSubmissions.createdAt), desc(formSubmissions.id))
      .limit(limit + 1);
    const [total] = await view.db.select({ n: count() }).from(formSubmissions).where(where);
    const shown = rows.slice(0, limit);
    return {
      submissions: shown.map(ownerSubmission),
      total: Number(total?.n ?? 0),
      next_cursor: rows.length > limit ? encodeCursor(shown[shown.length - 1]) : null,
    };
  },

  async *csv(view, q) {
    const rows = await view.db
      .select()
      .from(formSubmissions)
      .where(whereOf(view.app.id, q))
      .orderBy(desc(formSubmissions.createdAt), desc(formSubmissions.id))
      .limit(CSV_MAX_ROWS);
    yield* submissionsCsv(rows);
  },

  async remove(view, id) {
    const gone = await view.db
      .delete(formSubmissions)
      .where(and(eq(formSubmissions.appId, view.app.id), eq(formSubmissions.id, id)))
      .returning({ id: formSubmissions.id });
    return gone.length > 0;
  },
};
