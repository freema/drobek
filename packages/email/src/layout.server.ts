/**
 * The drobek e-mail layout: minimal, white, one narrow column, no card —
 * the wordmark with the crumb, the body, a one-line footer. Table-based and
 * inline-styled for mail clients; no images (they are blocked by default in
 * most clients), so the crumb is a plain coloured cell.
 */
const BRAND = {
  bg: '#ffffff',
  ink: '#1a1a1a',
  muted: '#555555',
  line: '#e7e5e1',
  faint: '#8a8a8e',
  crumb: '#d99a4e',
};

export interface EmailLayoutInput {
  preview: string;
  body: string;
  footNote?: string;
}

const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function renderEmailLayout({
  preview,
  body,
  footNote,
}: EmailLayoutInput): string {
  const previewHidden = `<div style="display:none;font-size:1px;color:${BRAND.bg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preview)}</div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>drobek</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.bg};font-family:${FONT};color:${BRAND.ink};">
    ${previewHidden}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bg};">
      <tr>
        <td align="center" style="padding:40px 20px 48px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;">
            <tr>
              <td style="padding:0 0 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="vertical-align:middle;"><div style="width:10px;height:10px;background:${BRAND.crumb};font-size:0;line-height:0;"></div></td>
                    <td style="padding-left:8px;font-size:17px;font-weight:600;letter-spacing:-0.02em;color:${BRAND.ink};">drobek</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="font-size:15px;line-height:1.6;color:${BRAND.ink};">
                ${body}
              </td>
            </tr>
            <tr>
              <td style="padding:32px 0 0;">
                <div style="border-top:1px solid ${BRAND.line};padding-top:16px;color:${BRAND.faint};font-size:12px;line-height:1.55;">
                  ${footNote ?? 'Sent by drobek — a cloud workspace for agent-built web apps.'}
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

export const emailBrand = BRAND;
