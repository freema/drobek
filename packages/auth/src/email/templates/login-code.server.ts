import { emailBrand, escapeHtml, renderEmailLayout } from '../layout.server.js';

export interface LoginCodeVars {
  code: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderLoginCodeEmail(vars: LoginCodeVars): RenderedEmail {
  const code = vars.code.trim();
  // Subject includes the 6-digit code (spec §5) — visible without opening.
  const subject = `drobek — your sign-in code: ${code}`;

  const codeChars = code
    .split('')
    .map(
      (ch) =>
        `<span style="display:inline-block;min-width:36px;padding:10px 4px;margin:0 3px;border:1px solid ${emailBrand.line};border-radius:8px;background:#fafafa;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:24px;font-weight:600;color:${emailBrand.ink};">${escapeHtml(ch)}</span>`
    )
    .join('');

  const body = `
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:600;color:${emailBrand.ink};">
      Your sign-in code
    </h1>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.55;color:${emailBrand.muted};">
      Enter this code on the drobek sign-in page. It is valid for 10 minutes and can be used once.
    </p>
    <div style="text-align:center;margin:8px 0 24px;">
      ${codeChars}
    </div>
    <div style="border-top:1px solid ${emailBrand.line};padding-top:16px;font-size:12.5px;line-height:1.55;color:${emailBrand.muted};">
      If you did not request this, you can safely ignore this email — nothing happens without the code.
    </div>
  `;

  const html = renderEmailLayout({
    preview: `Your sign-in code: ${code}`,
    body,
  });

  const text = [
    `Your drobek sign-in code: ${code}`,
    '',
    'It is valid for 10 minutes and can be used once.',
    '',
    'If you did not request this, you can safely ignore this email.',
  ].join('\n');

  return { subject, html, text };
}
