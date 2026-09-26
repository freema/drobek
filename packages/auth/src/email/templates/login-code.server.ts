import { emailBrand, escapeHtml, renderEmailLayout } from '@drobek/email';

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

  // One string, not a box per digit: it copies and autofills as a whole.
  const body = `
    <h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:600;color:${emailBrand.ink};">Your sign-in code</h1>
    <p style="margin:0 0 24px;color:${emailBrand.muted};">Enter it on the drobek sign-in page. It works once, for 10 minutes.</p>
    <p style="margin:0 0 24px;font-family:'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;font-size:32px;line-height:1.2;font-weight:600;letter-spacing:0.25em;color:${emailBrand.ink};">${escapeHtml(code)}</p>
    <p style="margin:0;font-size:13px;color:${emailBrand.faint};">Didn&#39;t ask for it? Ignore this e-mail — nobody can sign in without the code.</p>
  `;

  const html = renderEmailLayout({
    preview: `Your sign-in code: ${code}`,
    body,
  });

  const text = [
    `Your drobek sign-in code: ${code}`,
    '',
    'It works once, for 10 minutes.',
    '',
    "Didn't ask for it? Ignore this e-mail: nobody can sign in without the code.",
  ].join('\n');

  return { subject, html, text };
}
