/**
 * The few pages an app host renders itself (M0-06): not found, not published,
 * the password form, and the 451 "taken down" page (M4-02). Plain HTML with one inline <style> (allowed by the app
 * CSP's style-src 'unsafe-inline'), no script, and the form posts to the same
 * host (form-action 'self'). Every value is HTML-escaped.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  body{font-family:system-ui,-apple-system,sans-serif;background:#f6f7f9;color:#1f2328;display:grid;place-items:center;min-height:100vh;margin:0;padding:1rem;box-sizing:border-box}
  main{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.08);width:min(92vw,380px)}
  h1{font-size:1.1rem;margin:0 0 .5rem}
  p{margin:.25rem 0;color:#57606a;font-size:.95rem;line-height:1.45}
  label{display:block;font-size:.8rem;margin:1rem 0 .35rem;color:#57606a}
  input{width:100%;box-sizing:border-box;padding:.6rem .7rem;border-radius:8px;border:1px solid #d0d7de;font-size:1rem}
  button{margin-top:1rem;width:100%;padding:.65rem;border:0;border-radius:8px;background:#1f6feb;color:#fff;font-size:1rem;cursor:pointer}
  .err{color:#cf222e;font-size:.9rem;margin:.75rem 0 0}
  a{color:#1f6feb}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body><main>${body}</main></body></html>
`;
}

export type MissingReason = 'no-app' | 'not-published' | 'nothing-compiled' | 'no-version' | 'no-file';

const MISSING: Record<MissingReason, { title: string; text: string }> = {
  'no-app': { title: 'Not found', text: 'There is no app at this address.' },
  'not-published': {
    title: 'Not published yet',
    text: 'This app exists but has not been published yet.',
  },
  'nothing-compiled': {
    title: 'Nothing to preview yet',
    text: 'No version of this app has compiled yet.',
  },
  'no-version': { title: 'Not found', text: 'This version does not exist or did not compile.' },
  'no-file': { title: 'Not found', text: 'This page does not exist in the app.' },
};

export function missingPage(reason: MissingReason): string {
  const m = MISSING[reason];
  return layout(m.title, `<h1>${escapeHtml(m.title)}</h1><p>${escapeHtml(m.text)}</p>`);
}

export const UNLOCK_PATH = '/__drobek/password';

export function passwordPage(opts: { next: string; error?: 'wrong' | 'rate_limited' | null }): string {
  const error =
    opts.error === 'wrong'
      ? '<p class="err" role="alert">Incorrect password. Try again.</p>'
      : opts.error === 'rate_limited'
        ? '<p class="err" role="alert">Too many attempts. Wait a few minutes and try again.</p>'
        : '';
  return layout(
    'Password required',
    `<form method="POST" action="${UNLOCK_PATH}">
  <h1>This app is password protected</h1>
  <p>Enter the password to continue.</p>
  <input type="hidden" name="next" value="${escapeHtml(opts.next)}">
  <label for="drobek-app-password">Password</label>
  <input id="drobek-app-password" name="password" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Unlock</button>
  ${error}
</form>`
  );
}

export function errorPage(title: string, text: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`);
}

/**
 * 451 Unavailable For Legal Reasons (RFC 7725) — a super-admin took the app
 * down (NSO-293). Names the reason category only, links the operator's terms.
 */
export function lockedPage(opts: { reasonLabel: string; termsUrl: string }): string {
  return layout(
    'Unavailable',
    `<h1>This app is unavailable</h1>
  <p>It was taken down by the operator of this server for a violation of the terms of service (${escapeHtml(opts.reasonLabel.toLowerCase())}).</p>
  <p><a href="${escapeHtml(opts.termsUrl)}" rel="noopener noreferrer">Terms of service</a></p>`
  );
}
