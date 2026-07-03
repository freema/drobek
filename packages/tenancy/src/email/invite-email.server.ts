/**
 * Workspace-invite email (U4, PHY-54) — rendered with the shared @drobek/auth
 * layout and delivered over the SAME generic SMTP transport (Hostinger in
 * prod, mailpit locally). Addresses are masked in every log line.
 */
import {
  emailBrand,
  escapeHtml,
  getEmailFrom,
  getSmtpTransport,
  logger,
  maskEmail,
  renderEmailLayout,
  smtpConfigured,
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

export function renderInviteEmail(vars: InviteEmailVars): RenderedInviteEmail {
  const subject = `drobek — you're invited to “${vars.workspaceName}”`;
  const safeName = escapeHtml(vars.workspaceName);
  const safeRole = escapeHtml(vars.role);
  const safeUrl = escapeHtml(vars.acceptUrl);

  const body = `
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:600;color:${emailBrand.ink};">
      You&#39;re invited
    </h1>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.55;color:${emailBrand.muted};">
      You have been invited to join the workspace <strong style="color:${emailBrand.ink};">${safeName}</strong>
      on drobek as <strong style="color:${emailBrand.ink};">${safeRole}</strong>.
    </p>
    <p style="margin:0 0 20px;">
      <a href="${safeUrl}" style="display:inline-block;padding:10px 18px;background:${emailBrand.ink};color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
        Accept invitation
      </a>
    </p>
    <p style="margin:0;font-size:12px;line-height:1.55;color:${emailBrand.faint};word-break:break-all;">
      Or open this link: ${safeUrl}<br />
      The invitation expires in 7 days and can be used once.
    </p>`;

  const text = [
    `You have been invited to join the workspace "${vars.workspaceName}" on drobek as ${vars.role}.`,
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
    }),
    text,
  };
}

/** Deliver the invite via SMTP (dev fallback without SMTP: log the link). */
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

  if (smtpConfigured()) {
    const t = await getSmtpTransport();
    await t.sendMail({
      from: getEmailFrom(),
      to: args.email,
      subject,
      text,
      html,
    });
    logger.info('[mail] workspace invite sent', {
      email: maskEmail(args.email),
    });
    return;
  }

  if (process.env.NODE_ENV !== 'production') {
    logger.info('[mail] SMTP not configured — dev fallback, logging invite', {
      email: maskEmail(args.email),
      acceptUrl: args.acceptUrl,
    });
    return;
  }

  throw new Error(
    'Configure SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS for production'
  );
}
