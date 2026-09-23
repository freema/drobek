/**
 * A plain-text message in the drobek layout: the text is HTML-escaped and
 * shown as-is (`white-space: pre-wrap`), so whatever an app or its visitors
 * put into a message (form fields, a notification text) can never become
 * markup, a link target or a script in the recipient's mail client.
 */
import { escapeHtml, renderEmailLayout } from './layout.server.js';

export interface TextEmailInput {
  /** The one-line subject (also the hidden inbox preview). */
  subject: string;
  /** Plain text; newlines are kept. */
  text: string;
  /** Plain-text foot note (escaped); the layout's default when omitted. */
  footNote?: string;
}

export function renderTextEmailHtml({ subject, text, footNote }: TextEmailInput): string {
  return renderEmailLayout({
    preview: subject,
    body: `<p style="white-space:pre-wrap;word-break:break-word;margin:0;font-size:14px;line-height:1.55;">${escapeHtml(text)}</p>`,
    ...(footNote !== undefined ? { footNote: escapeHtml(footNote) } : {}),
  });
}
