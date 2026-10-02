/**
 * list_activity — the workspace's audit trail over MCP, parity with the
 * dashboard's Activity page: the same read (`listActivity`, strictly scoped
 * to the authorized workspace, newest first, keyset pages), the same filters
 * (app, action, actor kind, an inclusive UTC day range) and the same floor —
 * workspace admins (and super-admins) only. Each entry's stored context is
 * redacted like the page's "Technical details" (`redactAuditMeta`); the
 * entries answer inside an untrusted envelope (owner-list.ts) because their
 * context carries names and texts people chose.
 */
import { listActivity, parseActorKind, redactAuditMeta, type AuditActorKind } from '@drobek/audit';
import { authorizeWorkspace } from './access.js';
import { ToolError } from './errors.js';
import { budgetFlags, cappedPage, cursorArg, dayArg, dayRange, limitArg, textArg, type OwnerListPayload } from './owner-list.js';
import type { CallContext } from './tools.js';

const ACTIVITY_DEFAULT = 50;
const ACTION_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export async function listActivityTool(
  ctx: CallContext,
  args: { workspace: string; app?: string; action?: string; actor?: string; from?: string; to?: string; limit?: number; cursor?: string }
): Promise<OwnerListPayload> {
  if (typeof args.workspace !== 'string' || args.workspace.length === 0) {
    throw new ToolError('invalid_params', '`workspace` must be a workspace slug (list_apps lists yours).');
  }
  const ws = await authorizeWorkspace(ctx.principal, args.workspace, 'workspace-admin');
  const app = textArg(args.app, 'app', 64);
  const action = textArg(args.action, 'action', 64);
  if (action !== undefined && !ACTION_RE.test(action)) throw new ToolError('invalid_params', '`action` must be an audit action, e.g. "app.publish".');
  let actor: AuditActorKind | null = null;
  if (args.actor !== undefined && args.actor !== null && args.actor !== '') {
    actor = parseActorKind(typeof args.actor === 'string' ? args.actor : null);
    if (!actor) throw new ToolError('invalid_params', '`actor` must be "user", "agent" or "end_user".');
  }
  const range = dayRange(dayArg(args.from, 'from'), dayArg(args.to, 'to'));
  const limit = limitArg(args.limit, ACTIVITY_DEFAULT);
  const cursor = cursorArg(args.cursor);

  const read = await cappedPage(
    (n) => listActivity({ workspaceId: ws.id, subject: app ?? null, action: action ?? null, actorKind: actor, from: range.start, until: range.until, cursor, limit: n }),
    (p) =>
      p.rows.map((r) => ({
        at: r.createdAt.toISOString(),
        action: r.action,
        actor_kind: r.actorKind,
        actor: r.actorEmail,
        subject_type: r.subjectType,
        subject: r.target,
        meta: redactAuditMeta(r.meta ?? null),
      })),
    limit
  );
  const flags = budgetFlags(read, 'call again with next_cursor for the rest.', "the dashboard's Activity page shows it in full.");
  const filtered = app !== undefined || action !== undefined || actor !== null || range.start !== null || range.until !== null;
  const empty = read.entries.length > 0 || cursor ? null : filtered ? 'No activity matches this filter.' : 'Nothing has happened in this workspace yet.';
  const notes = [...flags.notes, ...(empty ? [empty] : [])];
  return {
    workspace: ws.slug,
    filter: {
      ...(app ? { app } : {}),
      ...(action ? { action } : {}),
      ...(actor ? { actor } : {}),
      ...(range.from ? { from: range.from } : {}),
      ...(range.to ? { to: range.to } : {}),
    },
    entries: read.entries,
    next_cursor: read.page.nextCursor,
    ...(flags.cut ? { cut: true } : {}),
    ...(flags.clipped ? { clipped: true } : {}),
    untrusted: true,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}
