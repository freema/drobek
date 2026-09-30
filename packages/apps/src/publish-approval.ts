/**
 * Who may publish, the pure half. Sign-up, workspaces, apps,
 * versions, previews and data stay open in every mode; only putting a
 * version on the production host is decided here.
 *
 *  - `PUBLISH_APPROVAL=open` (the default): every workspace may publish;
 *    `approval`: a workspace publishes once a super-admin allowed it (or when
 *    a super-admin is its member).
 *  - Per workspace a super-admin sets `default` (the server mode decides),
 *    `allowed` or `blocked` (refused in both modes).
 *  - `PUBLISH_NOTIFY` (`off` | `first` | `every`) e-mails the operator about
 *    publishes.
 *
 * The contact a refused user is shown, and the recipients of approval
 * requests and publish notifications: `OPERATOR_EMAIL`, else every
 * SUPERADMIN_EMAIL address (the first one is the contact shown).
 */

export const PUBLISH_APPROVAL_MODES = ['open', 'approval'] as const;

export type PublishApprovalMode = (typeof PUBLISH_APPROVAL_MODES)[number];

/** A workspace's publishing state as a super-admin set it. */
export const WORKSPACE_PUBLISHING_STATES = ['default', 'allowed', 'blocked'] as const;

export type WorkspacePublishing = (typeof WORKSPACE_PUBLISHING_STATES)[number];

export function isWorkspacePublishing(value: unknown): value is WorkspacePublishing {
  return typeof value === 'string' && (WORKSPACE_PUBLISHING_STATES as readonly string[]).includes(value);
}

export const PUBLISH_NOTIFY_MODES = ['off', 'first', 'every'] as const;

export type PublishNotifyMode = (typeof PUBLISH_NOTIFY_MODES)[number];

/** The super-admin page that lists workspaces with their publishing state. */
export const PUBLISH_APPROVAL_PATH = '/admin/publishing';

/** At most one approval-request e-mail per workspace in this window (until a decision). */
export const PUBLISH_APPROVAL_REQUEST_EVERY_MS = 24 * 60 * 60 * 1000;

/** PUBLISH_NOTIFY=every: at most one publish e-mail per app in this window. */
export const PUBLISH_NOTIFY_EVERY_MS = 60 * 60 * 1000;

const EMAIL_RE = /^[^\s@,<>"]+@[^\s@,<>"]+$/;

function rawMode(env: NodeJS.ProcessEnv): string {
  return (env.PUBLISH_APPROVAL ?? '').trim().toLowerCase();
}

function rawNotify(env: NodeJS.ProcessEnv): string {
  return (env.PUBLISH_NOTIFY ?? '').trim().toLowerCase();
}

/** The configured mode; an unknown value counts as `approval` (fail closed — the server refuses to start with one anyway). */
export function publishApprovalMode(env: NodeJS.ProcessEnv = process.env): PublishApprovalMode {
  const v = rawMode(env);
  return v === '' || v === 'open' ? 'open' : 'approval';
}

/** PUBLISH_NOTIFY; unset or unknown = `off` (the server refuses to start on an unknown value). */
export function publishNotifyMode(env: NodeJS.ProcessEnv = process.env): PublishNotifyMode {
  const v = rawNotify(env);
  return v === 'first' || v === 'every' ? v : 'off';
}

/** Every SUPERADMIN_EMAIL address, normalized (@drobek/auth cannot be imported here). */
export function superAdminAddresses(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...new Set(
      (env.SUPERADMIN_EMAIL ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

/** Who receives approval requests and publish notifications: OPERATOR_EMAIL, else the super-admins. */
export function operatorEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  const operator = (env.OPERATOR_EMAIL ?? '').trim().toLowerCase();
  return operator ? [operator] : superAdminAddresses(env);
}

/** The one address a refused user is shown (null when nothing is configured). */
export function operatorContact(env: NodeJS.ProcessEnv = process.env): string | null {
  return operatorEmails(env)[0] ?? null;
}

/** Start-time check of PUBLISH_APPROVAL / OPERATOR_EMAIL / PUBLISH_NOTIFY (null = fine). */
export function publishApprovalConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const mode = rawMode(env);
  if (mode !== '' && !(PUBLISH_APPROVAL_MODES as readonly string[]).includes(mode)) {
    return `drobek refuses to start: PUBLISH_APPROVAL must be "open" or "approval" (got "${env.PUBLISH_APPROVAL}").`;
  }
  const notify = rawNotify(env);
  if (notify !== '' && !(PUBLISH_NOTIFY_MODES as readonly string[]).includes(notify)) {
    return `drobek refuses to start: PUBLISH_NOTIFY must be "off", "first" or "every" (got "${env.PUBLISH_NOTIFY}").`;
  }
  const operator = (env.OPERATOR_EMAIL ?? '').trim();
  if (operator && !EMAIL_RE.test(operator)) {
    return 'drobek refuses to start: OPERATOR_EMAIL must be one e-mail address.';
  }
  if (publishApprovalMode(env) === 'approval') {
    if (superAdminAddresses(env).length === 0) {
      return 'drobek refuses to start: PUBLISH_APPROVAL=approval needs a super-admin to approve workspaces — set SUPERADMIN_EMAIL.';
    }
    if (!operatorContact(env)) {
      return 'drobek refuses to start: PUBLISH_APPROVAL=approval needs a contact for blocked users — set OPERATOR_EMAIL or SUPERADMIN_EMAIL.';
    }
  }
  return null;
}

function operatorOf(contact: string | null): string {
  return contact ?? 'the operator of this server';
}

/** The one sentence the dashboard shows next to a publish control of an unapproved workspace. */
export function publishApprovalNotice(contact: string | null): string {
  return `Publishing on this server needs approval from ${operatorOf(contact)}.`;
}

/** The `publish_not_approved` message — the same in MCP and the dashboard. */
export function publishNotApprovedMessage(contact: string | null): string {
  const who = operatorOf(contact);
  return `Publishing on this server needs approval from ${who}, and this workspace is not approved yet. An approval request was sent to ${who}; publish again once they approve the workspace. Previews, versions and everything else keep working.`;
}

/** The one sentence the dashboard shows next to a publish control of a blocked workspace. */
export function publishBlockedNotice(contact: string | null): string {
  return contact
    ? `Publishing from this workspace was turned off by the operator (${contact}).`
    : 'Publishing from this workspace was turned off by the operator.';
}

/** The `publish_blocked` message — the same in MCP and the dashboard. */
export function publishBlockedMessage(contact: string | null): string {
  const by = contact ? `the operator of this server (${contact})` : 'the operator of this server';
  return `Publishing from this workspace was turned off by ${by}. Previews, versions and everything else keep working; live apps keep serving unless taken down.`;
}
