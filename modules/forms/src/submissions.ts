/**
 * `mod_forms_submissions` reads and writes. Every query is filtered by the
 * app id the runtime scoped the context to.
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { apps, workspaces, type DB } from '@drobek/db';
import { formSubmissions, type FieldValue, type FormSubmissionRow } from './schema.js';

export function newSubmissionId(): string {
  return `fs_${randomBytes(12).toString('hex')}`;
}

export async function insertSubmission(
  db: DB,
  row: { id: string; appId: string; form: string; data: Record<string, FieldValue>; ipHash: string | null; userId: string | null }
): Promise<FormSubmissionRow> {
  // A JS timestamp (millisecond precision) so the page cursor compares exactly.
  const [inserted] = await db.insert(formSubmissions).values({ ...row, createdAt: new Date() }).returning();
  return inserted;
}

export async function markNotified(db: DB, appId: string, id: string): Promise<void> {
  await db
    .update(formSubmissions)
    .set({ notifiedAt: new Date() })
    .where(and(eq(formSubmissions.appId, appId), eq(formSubmissions.id, id)));
}

export interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(row: Pick<FormSubmissionRow, 'createdAt' | 'id'>): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || !/^fs_[0-9a-f]{24}$/.test(id) || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

/** Newest first; `before` = the cursor of the last row of the previous page. */
export async function listSubmissions(db: DB, appId: string, form: string, limit: number, before: Cursor | null): Promise<FormSubmissionRow[]> {
  const scope = and(eq(formSubmissions.appId, appId), eq(formSubmissions.form, form));
  const where = before
    ? and(
        scope,
        or(
          lt(formSubmissions.createdAt, before.createdAt),
          and(eq(formSubmissions.createdAt, before.createdAt), lt(formSubmissions.id, before.id))
        )
      )
    : scope;
  return db
    .select()
    .from(formSubmissions)
    .where(where)
    .orderBy(desc(formSubmissions.createdAt), desc(formSubmissions.id))
    .limit(limit);
}

/** The app's display name and its workspace slug (for the notification e-mail). */
export async function appInfo(db: DB, appId: string): Promise<{ name: string | null; workspaceSlug: string | null }> {
  const [row] = await db
    .select({ name: apps.name, workspaceSlug: workspaces.slug })
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(eq(apps.id, appId))
    .limit(1);
  return { name: row?.name ?? null, workspaceSlug: row?.workspaceSlug ?? null };
}
