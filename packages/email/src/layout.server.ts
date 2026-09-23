/**
 * Minimal branded e-mail layout — matches the app's plain light system-ui
 * look (apps/web/app/routes/_index.tsx), table-based for mail clients.
 */
const BRAND = {
  bg: '#f4f4f5',
  card: '#ffffff',
  ink: '#1a1a1a',
  muted: '#555555',
  line: '#e4e4e7',
  faint: '#8a8a8e',
};

export interface EmailLayoutInput {
  preview: string;
  body: string;
  footNote?: string;
}

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
    <title>drobek</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.bg};font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${BRAND.ink};">
    ${previewHidden}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bg};padding:32px 16px 48px;">
      <tr>
        <td align="center">
          <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;">
            <tr>
              <td style="padding:0 4px 16px 4px;">
                <span style="color:${BRAND.ink};font-weight:600;font-size:18px;letter-spacing:-0.02em;">drobek</span>
              </td>
            </tr>
            <tr>
              <td style="background:${BRAND.card};border:1px solid ${BRAND.line};border-radius:12px;padding:32px 32px 28px;">
                ${body}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 4px 0 4px;color:${BRAND.faint};font-size:12px;line-height:1.55;">
                ${footNote ?? 'This email was sent by drobek — MCP-native hosting for vibecoded static micro-apps. If you did not request it, you can safely ignore it.'}
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
