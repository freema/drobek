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

export type AppVisibility = 'public' | 'team' | 'password';
export type AppLiveStatus = 'live' | 'hibernated';

/** Mirrors the `deploy_state` pg enum (kept local so no bullmq barrel leaks). */
export type DeployStateName =
  | 'awaiting_upload'
  | 'queued'
  | 'linting'
  | 'storing'
  | 'activating'
  | 'ready'
  | 'failed';

/** The U7 hardened same-origin serving path for a deployed app. */
export function servePath(workspaceSlug: string, appSlug: string): string {
  return `/${workspaceSlug}/app/${appSlug}`;
}

// ── Apps list ────────────────────────────────────────────────────────────────

/** A db row for the apps-list shaping (from apps.server.ts). */
export interface AppListRow {
  slug: string;
  status: AppLiveStatus;
  visibility: AppVisibility;
  activeDeployId: string | null;
  createdAt: Date;
  /** activatedAt of the app's active deploy — the "last deployed (live)" time. */
  lastDeployAt: Date | null;
}

export interface AppListItem {
  slug: string;
  status: AppLiveStatus;
  visibility: AppVisibility;
  /** True once the app has an active (served) deploy. */
  live: boolean;
  /** Relative live URL `/:ws/app/:slug`. */
  url: string;
  createdAt: string;
  lastDeployAt: string | null;
}

/**
 * Shape the workspace's apps for the list view: newest-created first, slug as a
 * stable tie-break. `live` reflects whether a deploy is currently active.
 */
export function shapeApps(
  rows: AppListRow[],
  workspaceSlug: string
): AppListItem[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        a.slug.localeCompare(b.slug)
    )
    .map((r) => ({
      slug: r.slug,
      status: r.status,
      visibility: r.visibility,
      live: r.activeDeployId !== null,
      url: servePath(workspaceSlug, r.slug),
      createdAt: r.createdAt.toISOString(),
      lastDeployAt: r.lastDeployAt ? r.lastDeployAt.toISOString() : null,
    }));
}

// ── Deploy history ───────────────────────────────────────────────────────────

export type LintStatus = 'clean' | 'blocked' | 'unknown';

/** A db row for the deploy-history shaping (from apps.server.ts). */
export interface DeployHistoryRow {
  id: string;
  state: DeployStateName;
  createdAt: Date;
  activatedAt: Date | null;
  /** The stored lint report jsonb, or null before linting ran. */
  lintReport: { ok?: boolean } | null;
}

export interface DeployHistoryItem {
  id: string;
  /** First 8 chars — the human-friendly short id shown in the UI. */
  shortId: string;
  state: DeployStateName;
  /** True when this deploy is the one `apps.active_deploy_id` points at. */
  active: boolean;
  createdAt: string;
  activatedAt: string | null;
  lintStatus: LintStatus;
  /** A prior READY deploy that is NOT the active one → a rollback target. */
  rollbackTarget: boolean;
}

export function deployShortId(id: string): string {
  return id.slice(0, 8);
}

/** clean ⇔ lint report present with ok=true; blocked ⇔ ok=false; else unknown. */
export function lintStatusOf(report: { ok?: boolean } | null): LintStatus {
  if (report && typeof report.ok === 'boolean') {
    return report.ok ? 'clean' : 'blocked';
  }
  return 'unknown';
}

/**
 * Shape the app's deploy history: newest-created first (id as a stable
 * tie-break), the active deploy flagged, and each prior READY deploy marked as
 * a rollback target. Role gating (whether the button renders / the action is
 * allowed) is a SEPARATE decision — see canRollback.
 */
export function shapeDeployHistory(
  rows: DeployHistoryRow[],
  activeDeployId: string | null
): DeployHistoryItem[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id)
    )
    .map((r) => ({
      id: r.id,
      shortId: deployShortId(r.id),
      state: r.state,
      active: r.id === activeDeployId,
      createdAt: r.createdAt.toISOString(),
      activatedAt: r.activatedAt ? r.activatedAt.toISOString() : null,
      lintStatus: lintStatusOf(r.lintReport),
      rollbackTarget: r.state === 'ready' && r.id !== activeDeployId,
    }));
}

// ── Rollback authorization (pure) ────────────────────────────────────────────

/**
 * The rollback authorization decision, as a pure function (the same rule
 * @drobek/deploy's rollback enforces): allowed for editor / workspace-admin
 * (and super-admin, whose effective workspace role is 'workspace-admin');
 * DENIED for a viewer or a non-member (null effective role). This gates BOTH
 * whether the "Roll back" button renders AND — enforced server-side in the
 * action via requireWorkspaceRole('editor') — whether the POST is accepted.
 */
export function canRollback(effectiveRole: WorkspaceRole | null): boolean {
  return effectiveRole !== null && roleAtLeast(effectiveRole, 'editor');
}

/**
 * The Data-tab delete authorization (M1b, PHY-121), same rule as rollback:
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
  /** Badge text mirrors actorKind: 'agent' | 'user'. */
  actorBadge: AuditActorKind;
  /** Which human/agent: the actor's email, or 'system' when there is no actor. */
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
      actorLabel: r.actorEmail ?? 'system',
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
