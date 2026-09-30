/**
 * Activity (audit) CSV serialization. Reuses the RFC-4180
 * escaping primitive (`csvLine` from @drobek/core) so the audit export escapes
 * commas / quotes / newlines identically to the Data-tab export. Pure + unit
 * tested; imported only server-side (the export route streams these lines).
 *
 * Columns are fixed (governance, not a user schema): the ISO instant, the action,
 * the actor_kind (agent|user), the actor email, the subject (type + id) and the
 * readable summary the Activity table shows (secret-free). The
 * invited email is never in an invite row's subject, so no PII leaks beyond the
 * actor email that the admin viewer is already entitled to see.
 */
import { csvLine } from '@drobek/core';

export const ACTIVITY_CSV_HEADER = [
  'time',
  'action',
  'actor_kind',
  'actor',
  'subject_type',
  'subject',
  'summary',
] as const;

/** A minimal, db-free row for CSV serialization (from the raw audit read). */
export interface ActivityCsvRow {
  /** The audit row's created_at as an ISO-8601 UTC instant. */
  createdAt: string;
  action: string;
  actorKind: string;
  /** The actor's email, or '' for an actor-less (system) row. */
  actor: string;
  subjectType: string | null;
  subject: string | null;
  summary: string;
}

/** The header line (RFC-4180). */
export function activityCsvHeaderLine(): string {
  return csvLine([...ACTIVITY_CSV_HEADER]);
}

/** One escaped CSV data line for an audit row. */
export function activityCsvRowLine(row: ActivityCsvRow): string {
  return csvLine([
    row.createdAt,
    row.action,
    row.actorKind,
    row.actor,
    row.subjectType ?? '',
    row.subject ?? '',
    row.summary,
  ]);
}
