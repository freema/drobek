/**
 * Workspace-invite email (U4, PHY-54) — rendered with the shared @drobek/auth
 * layout and delivered over the SAME operator transport as the sign-in codes
 * (@drobek/email: SMTP or Resend per EMAIL_TRANSPORT, mailpit locally).
 * Addresses are masked in every log line.
 */
import {
  emailBrand,
  escapeHtml,
  logger,
  maskEmail,
  renderEmailActionsHtml,
  renderEmailLayout,
  sendEmail,
  serverFootNote,
  serverHost,
} from '@drobek/auth';
import type { WorkspaceRole } from '../roles.js';

export interface InviteEmailVars {
  workspaceName: string;
  role: WorkspaceRole;
  acceptUrl: string;
}

export interface RenderedInviteEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderInviteEmail(vars: InviteEmailVars, env: NodeJS.ProcessEnv = process.env): RenderedInviteEmail {
  const subject = `drobek — you're invited to “${vars.workspaceName}”`;
  const safeName = escapeHtml(vars.workspaceName);
  const safeRole = escapeHtml(vars.role);
  const host = serverHost(env);

  const body = `
    <h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:600;color:${emailBrand.ink};">You&#39;re invited</h1>
    <p style="margin:0;color:${emailBrand.muted};">
      You have been invited to join the workspace <strong style="color:${emailBrand.ink};">${safeName}</strong>
      on the drobek server at ${escapeHtml(host)} as <strong style="color:${emailBrand.ink};">${safeRole}</strong>.
    </p>
    ${renderEmailActionsHtml([{ label: 'Accept invitation', url: vars.acceptUrl }], env)}
    <p style="margin:16px 0 0;font-size:13px;line-height:1.55;color:${emailBrand.faint};">
      The invitation expires in 7 days and can be used once.
    </p>`;

  const text = [
    `You have been invited to join the workspace "${vars.workspaceName}" on the drobek server at ${host} as ${vars.role}.`,
    '',
    `Accept the invitation: ${vars.acceptUrl}`,
    '',
    'The invitation expires in 7 days and can be used once.',
  ].join('\n');

  return {
    subject,
    html: renderEmailLayout({
      preview: `You're invited to ${vars.workspaceName} on drobek`,
      body,
      footNote: escapeHtml(serverFootNote('a member of the workspace invited this address', env)),
    }),
    text,
  };
}

/** Deliver the invite through the operator's transport (dev fallback without SMTP: log the link). */
export async function sendInviteEmail(args: {
  email: string;
  workspaceName: string;
  role: WorkspaceRole;
  acceptUrl: string;
}): Promise<void> {
  const { subject, html, text } = renderInviteEmail({
    workspaceName: args.workspaceName,
    role: args.role,
    acceptUrl: args.acceptUrl,
  });

  // 'not_configured' only happens outside production (SMTP without SMTP_HOST).
  const r = await sendEmail({ to: args.email, subject, text, html });
  if (r === 'sent') {
    logger.info('[mail] workspace invite sent', {
      email: maskEmail(args.email),
    });
    return;
  }
  logger.info('[mail] SMTP not configured — dev fallback, logging invite', {
    email: maskEmail(args.email),
    acceptUrl: args.acceptUrl,
  });
}
