/**
 * Publish approval (NSO-366), the pure half: `PUBLISH_APPROVAL=open` (the
 * default) lets every workspace publish; `approval` lets a workspace publish
 * only once a super-admin approved it (or when a super-admin is its member).
 * Everything else — sign-up, workspaces, apps, versions, previews, data —
 * stays open in both modes.
 *
 * The contact a blocked user is shown, and the recipients of approval
 * requests: `OPERATOR_EMAIL`, else every SUPERADMIN_EMAIL address (the
 * first one is the contact shown).
 */

export const PUBLISH_APPROVAL_MODES = ['open', 'approval'] as const;

export type PublishApprovalMode = (typeof PUBLISH_APPROVAL_MODES)[number];

/** The super-admin page that lists workspaces with their approval state. */
export const PUBLISH_APPROVAL_PATH = '/admin/publishing';

/** At most one approval-request e-mail per workspace in this window (until a decision). */
export const PUBLISH_APPROVAL_REQUEST_EVERY_MS = 24 * 60 * 60 * 1000;

const EMAIL_RE = /^[^\s@,<>"]+@[^\s@,<>"]+$/;

function rawMode(env: NodeJS.ProcessEnv): string {
  return (env.PUBLISH_APPROVAL ?? '').trim().toLowerCase();
}

/** The configured mode; an unknown value counts as `approval` (fail closed — the server refuses to start with one anyway). */
export function publishApprovalMode(env: NodeJS.ProcessEnv = process.env): PublishApprovalMode {
  const v = rawMode(env);
  return v === '' || v === 'open' ? 'open' : 'approval';
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

/** Who receives approval requests: OPERATOR_EMAIL, else the super-admins. */
export function operatorEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  const operator = (env.OPERATOR_EMAIL ?? '').trim().toLowerCase();
  return operator ? [operator] : superAdminAddresses(env);
}

/** The one address a blocked user is shown (null when nothing is configured). */
export function operatorContact(env: NodeJS.ProcessEnv = process.env): string | null {
  return operatorEmails(env)[0] ?? null;
}

/** Start-time check of PUBLISH_APPROVAL / OPERATOR_EMAIL (null = fine). */
export function publishApprovalConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const mode = rawMode(env);
  if (mode !== '' && !(PUBLISH_APPROVAL_MODES as readonly string[]).includes(mode)) {
    return `drobek refuses to start: PUBLISH_APPROVAL must be "open" or "approval" (got "${env.PUBLISH_APPROVAL}").`;
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

/** The one sentence the dashboard shows next to a blocked publish control. */
export function publishApprovalNotice(contact: string | null): string {
  return `Publishing on this server needs approval from ${contact ?? 'the operator of this server'}.`;
}

/** The `publish_not_approved` message — the same in MCP and the dashboard. */
export function publishNotApprovedMessage(contact: string | null): string {
  const who = contact ?? 'the operator of this server';
  return `Publishing on this server needs approval from ${who}, and this workspace is not approved yet. An approval request was sent to ${who}; publish again once they approve the workspace. Previews, versions and everything else keep working.`;
}
