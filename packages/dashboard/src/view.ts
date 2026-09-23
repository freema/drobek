/**
 * @drobek/dashboard — pure view shaping for the U8 minimal dashboard (PHY-74
 * slice / PHY-62). These functions are db-free and unit-tested: the loaders in
 * ./routes/* fetch rows (apps.server.ts) and hand them here for shaping, so the
 * ordering / field-mapping / authz decisions are testable without a database.
 */
// Import from the server-free `/roles` subpath, NOT the @drobek/tenancy barrel:
// view.ts is shared client+server (the route components import formatTimestamp),
// and the barrel statically re-exports membership.server.js (DB) which the
// production react-router client build refuses to bundle.
import { roleAtLeast, type WorkspaceRole } from '@drobek/tenancy/roles';
import type { AuditActorKind } from '@drobek/audit/actor';

export type AppVisibility = 'public' | 'password';
export type AppLiveStatus = 'live' | 'hibernated';

/** Mirrors the `compile_status` pg enum. */
export type CompileStatusName = 'pending' | 'ok' | 'error';

// ── Apps list ────────────────────────────────────────────────────────────────

/** A db row for the apps-list shaping (from apps.server.ts). */
export interface AppListRow {
  slug: string;
  /** create_app's human-readable name (null for older apps → show the slug). */
  name?: string | null;
  status: AppLiveStatus;
  visibility: AppVisibility;
  publishedVersionId: string | null;
  createdAt: Date;
  /** Newest version's number (null before the first write). */
  latestVersion: number | null;
  /** When the newest version was written. */
  lastChangeAt: Date | null;
}

export interface AppListItem {
  slug: string;
  name: string | null;
  status: AppLiveStatus;
  visibility: AppVisibility;
  /** True once a version is published. */
  published: boolean;
  latestVersion: number | null;
  createdAt: string;
  lastChangeAt: string | null;
}

/**
 * Shape the workspace's apps for the list view: newest-created first, slug as a
 * stable tie-break.
 */
export function shapeApps(rows: AppListRow[]): AppListItem[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        a.slug.localeCompare(b.slug)
    )
    .map((r) => ({
      slug: r.slug,
      name: r.name ?? null,
      status: r.status,
      visibility: r.visibility,
      published: r.publishedVersionId !== null,
      latestVersion: r.latestVersion,
      createdAt: r.createdAt.toISOString(),
      lastChangeAt: r.lastChangeAt ? r.lastChangeAt.toISOString() : null,
    }));
}

// ── Version history ──────────────────────────────────────────────────────────

/** A version as the history table shows it (from @drobek/apps listVersions). */
export interface VersionHistoryRow {
  id: string;
  number: number;
  actorKind: AuditActorKind;
  reasoning: string | null;
  compileStatus: CompileStatusName;
  createdAt: Date;
  published: boolean;
}

export interface VersionHistoryItem {
  id: string;
  number: number;
  actorKind: AuditActorKind;
  reasoning: string | null;
  compileStatus: CompileStatusName;
  createdAt: string;
  published: boolean;
  /** A version that compiled and is not the published one → can be published. */
  publishable: boolean;
}

/**
 * Shape the version history: newest first, the published version flagged,
 * every other version that compiled `ok` publishable (publishing an older
 * version IS the rollback). Role gating is a separate decision — canPublish.
 */
export function shapeVersionHistory(rows: VersionHistoryRow[]): VersionHistoryItem[] {
  return [...rows]
    .sort((a, b) => b.number - a.number)
    .map((r) => ({
      id: r.id,
      number: r.number,
      actorKind: r.actorKind,
      reasoning: r.reasoning,
      compileStatus: r.compileStatus,
      createdAt: r.createdAt.toISOString(),
      published: r.published,
      publishable: r.compileStatus === 'ok' && !r.published,
    }));
}

// ── Publish authorization (pure) ─────────────────────────────────────────────

/**
 * The publish authorization decision, as a pure function: allowed for editor /
 * workspace-admin (and super-admin, whose effective workspace role is
 * 'workspace-admin'); DENIED for a viewer or a non-member (null effective
 * role). This gates BOTH whether the "Publish" button renders AND — enforced
 * server-side in the action via requireWorkspaceRole('editor') — whether the
 * POST is accepted.
 */
export function canPublish(effectiveRole: WorkspaceRole | null): boolean {
  return effectiveRole !== null && roleAtLeast(effectiveRole, 'editor');
}

/**
 * The Data-tab delete authorization (M1b, PHY-121), same rule as publish:
 * editor / workspace-admin (and super-admin ⇒ workspace-admin) may delete a
 * record; a viewer or non-member may NOT. Gates whether the delete affordance
 * renders; the action re-enforces it server-side via requireWorkspaceRole
 * ('editor'). Reads are open to any member (viewer+) and are NOT gated here.
 */
export function canDeleteRecord(effectiveRole: WorkspaceRole | null): boolean {
  return effectiveRole !== null && roleAtLeast(effectiveRole, 'editor');
}

// ── Activity / audit view (PHY-85) ───────────────────────────────────────────

/**
 * Governance read authorization, as a pure function: the workspace Activity view
 * (the audit trail) is workspace-admin / super-admin ONLY. A super-admin's
 * effective workspace role is 'workspace-admin', so this one rule covers it; an
 * editor, viewer, or non-member (null effective role) is DENIED. The route
 * re-enforces this server-side via requireWorkspaceRole('workspace-admin') — a
 * viewer/editor → 403, a non-member → 404, anonymous → /login redirect.
 */
export function canReadActivity(effectiveRole: WorkspaceRole | null): boolean {
  return effectiveRole !== null && roleAtLeast(effectiveRole, 'workspace-admin');
}

/** A raw audit row handed to the Activity shaping (db-free; from listActivity). */
export interface ActivityRowInput {
  id: string;
  actorEmail: string | null;
  actorKind: AuditActorKind;
  action: string;
  subjectType: string | null;
  subject: string | null;
  createdAt: Date;
}

export interface ActivityItem {
  id: string;
  action: string;
  /** agent (an MCP tool ran on behalf of a connected agent) vs user (a human). */
  actorKind: AuditActorKind;
  /** Badge text mirrors actorKind: 'agent' | 'user' | 'end_user'. */
  actorBadge: AuditActorKind;
  /**
   * Which human/agent: the actor's email, 'app end user' for an end-user row
   * (no drobek actor), or 'system' when there is no actor at all.
   */
  actorLabel: string;
  subjectType: string | null;
  subject: string | null;
  /** Deterministic UTC display time (SSR/CSR byte-identical). */
  time: string;
}

/**
 * Shape audit rows for the Activity table: newest-first (created_at desc, id desc
 * as a stable tie-break — the same order the keyset read returns, re-asserted here
 * so the pure shaping is deterministic on its own), an actor_kind badge, and the
 * actor's email (or 'system' for an actor-less row). No secrets/PII beyond the
 * email that the admin viewer is already entitled to see.
 */
export function shapeActivity(rows: ActivityRowInput[]): ActivityItem[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id)
    )
    .map((r) => ({
      id: r.id,
      action: r.action,
      actorKind: r.actorKind,
      actorBadge: r.actorKind,
      // End users (M1-01) are not drobek users: their rows carry no actor id.
      actorLabel: r.actorEmail ?? (r.actorKind === 'end_user' ? 'app end user' : 'system'),
      subjectType: r.subjectType,
      subject: r.subject,
      time: formatTimestamp(r.createdAt.toISOString()),
    }));
}

// ── Display helpers ──────────────────────────────────────────────────────────

/**
 * Deterministic UTC timestamp for display. MUST be locale/timezone-independent
 * so the SSR pass (container locale) and the client render byte-identical text —
 * `toLocaleString()` does NOT, and hydration-mismatches, discarding the subtree.
 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
