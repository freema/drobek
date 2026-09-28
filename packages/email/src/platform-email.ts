/**
 * Mail the drobek server itself sends (sign-in codes, invites, pending
 * changes, moderation, publishing, domains). Unlike an app's plain-text mail
 * (text-email.ts) it may carry ACTIONS: buttons to pages of this server. An
 * action's URL must be http(s) on the server's own origin (PUBLIC_APP_URL, or
 * PUBLIC_ORIGIN where invite links live), so even a platform caller cannot
 * render a link elsewhere; the body text stays escaped plain text. The module
 * e-mail an app sends (`ctx.email.send`) has no field that reaches here.
 */
import { emailBrand, emailFont, escapeHtml, renderEmailLayout } from './layout.server.js';

export interface EmailAction {
  /** Button text (plain, escaped). */
  label: string;
  /** An http(s) URL on this server's origin. */
  url: string;
}

export interface PlatformEmailInput {
  subject: string;
  /** Plain text above the buttons; newlines are kept. */
  text: string;
  actions?: EmailAction[];
  /** Plain text below the buttons. */
  closing?: string;
  /** Plain-text foot note; `Sent by the drobek server at <host>.` when omitted. */
  footNote?: string;
}

const DEV_ORIGIN = 'http://localhost:3041';

function originOf(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** The dashboard origin of this server: PUBLIC_APP_URL, else PUBLIC_ORIGIN, else the dev default. */
export function serverOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return originOf(env.PUBLIC_APP_URL) ?? originOf(env.PUBLIC_ORIGIN) ?? DEV_ORIGIN;
}

/** The host (+ port) the recipient knows this server by, e.g. `drobek.example.com`. */
export function serverHost(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(serverOrigin(env)).host;
}

/** `Sent by the drobek server at <host>[ because <reason>].` */
export function serverFootNote(reason: string | null, env: NodeJS.ProcessEnv = process.env): string {
  return `Sent by the drobek server at ${serverHost(env)}${reason ? ` because ${reason}` : ''}.`;
}

/** `url` when it is an http(s) URL on this server's origin (no credentials); throws otherwise. */
export function trustedActionUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('An e-mail action needs an absolute URL.');
  }
  const allowed = new Set([serverOrigin(env), originOf(env.PUBLIC_ORIGIN)].filter((o): o is string => o !== null));
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !allowed.has(u.origin)) {
    throw new Error("An e-mail action must link to this server's own origin (PUBLIC_APP_URL).");
  }
  return u.href;
}

/** Table-based buttons (they render in Outlook too), each with its address as a fallback line. */
export function renderEmailActionsHtml(actions: EmailAction[], env: NodeJS.ProcessEnv = process.env): string {
  return actions
    .map((a) => {
      const href = escapeHtml(trustedActionUrl(a.url, env));
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;">
  <tr>
    <td bgcolor="${emailBrand.ink}" style="border-radius:6px;background:${emailBrand.ink};">
      <a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:10px 18px;border:1px solid ${emailBrand.ink};border-radius:6px;font-family:${emailFont};font-size:14px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;">${escapeHtml(a.label)}</a>
    </td>
  </tr>
</table>
<p style="margin:0;font-size:12px;line-height:1.5;color:${emailBrand.faint};word-break:break-all;">Or open this address: ${href}</p>`;
    })
    .join('\n');
}

/** The text part: the text, one `<label>: <url>` line per action, the closing. */
export function platformEmailText(
  input: Pick<PlatformEmailInput, 'text' | 'actions' | 'closing'>,
  env: NodeJS.ProcessEnv = process.env
): string {
  const parts = [input.text.replace(/\n+$/, '')];
  const actions = input.actions ?? [];
  if (actions.length > 0) parts.push(actions.map((a) => `${a.label}: ${trustedActionUrl(a.url, env)}`).join('\n'));
  if (input.closing) parts.push(input.closing);
  return parts.join('\n\n');
}

function paragraph(text: string, extraStyle = ''): string {
  return `<p style="white-space:pre-wrap;word-break:break-word;margin:0;font-size:14px;line-height:1.55;${extraStyle}">${escapeHtml(text)}</p>`;
}

/** Text + HTML of a platform e-mail; throws when an action leaves this server's origin. */
export function renderPlatformEmail(input: PlatformEmailInput, env: NodeJS.ProcessEnv = process.env): { text: string; html: string } {
  const actions = input.actions ?? [];
  const body = [
    paragraph(input.text.replace(/\n+$/, '')),
    actions.length > 0 ? renderEmailActionsHtml(actions, env) : '',
    input.closing ? paragraph(input.closing, `margin-top:24px;color:${emailBrand.muted};`) : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    text: platformEmailText(input, env),
    html: renderEmailLayout({
      preview: input.subject,
      body,
      footNote: escapeHtml(input.footNote ?? serverFootNote(null, env)),
    }),
  };
}
