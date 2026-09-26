/**
 * GET|POST /__drobek/auth/callback/:provider — the IdP callback of an
 * end-user sign-in provider (NSO-348), on the DASHBOARD host: the one
 * redirect URI an operator registers with an IdP for every app of the
 * server. The dashboard session is never read or touched here.
 *
 * Generic glue: the request goes to the module runtime's `endUserCallback`
 * (the `endUsers` authority's `callback` — the auth module's flow.ts), which
 * checks the signed state, asks the provider for the verified identity,
 * applies the app's allowlist and answers either
 *
 *   - a redirect → 302 to `https://<app host>/__drobek/v1/auth/complete?code=…`
 *     (a 60-second, single-use handoff code bound to that app host), or
 *   - a page → a small HTML page (the reason, a link back to the app).
 *
 * A POST (SAML's HTTP-POST binding, OIDC `form_post`) is exempt from the
 * dashboard's Origin check (ORIGIN_CHECK_EXEMPT_PATHS): the IdP's page posts
 * it cross-site; the signed, single-use state is what authenticates it. Only
 * `application/x-www-form-urlencoded` bodies up to 256 KiB are read.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { getClientIp } from '@drobek/auth';
import { moduleRuntime, type EndUserCallbackResult } from '@drobek/modules';

/** The largest POST body read (a SAML response with a certificate fits easily). */
export const CALLBACK_MAX_BODY_BYTES = 256 * 1024;

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

function page(status: number, title: string, message: string, link?: { href: string; label: string }): Response {
  const back = link && isHttpUrl(link.href) ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5}h1{font-size:1.25rem}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
${back}
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP },
  });
}

/** The runtime's answer as an HTTP response. */
export function callbackResponse(result: EndUserCallbackResult): Response {
  if (result.kind === 'redirect') {
    if (!isHttpUrl(result.location)) return page(500, 'Sign-in failed', 'drobek hit an internal error. Start the sign-in again from the app.');
    return new Response(null, { status: 302, headers: { ...BASE_HEADERS, Location: result.location } });
  }
  const status = Number.isInteger(result.status) && result.status >= 400 && result.status <= 599 ? result.status : 500;
  return page(status, result.title, result.message, result.link);
}

/** First value of each parameter (a Map, so a `__proto__` key stays a plain key). */
function firstValues(params: URLSearchParams): Record<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of params) if (!out.has(k)) out.set(k, v);
  return Object.fromEntries(out);
}

type FormRead = { ok: true; body: Record<string, string> | null } | { ok: false };

/** The urlencoded form of a POST (≤ CALLBACK_MAX_BODY_BYTES), null for another content type. */
export async function readCallbackForm(request: Request, max = CALLBACK_MAX_BODY_BYTES): Promise<FormRead> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return { ok: true, body: null };
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return { ok: false };
  if (!request.body) return { ok: true, body: {} };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  return { ok: true, body: firstValues(new URLSearchParams(text)) };
}

async function handle(request: Request, provider: string | undefined, method: 'GET' | 'POST', body: Record<string, string> | null): Promise<Response> {
  const runtime = await moduleRuntime();
  const result = await runtime.endUserCallback({
    provider: provider ?? '',
    method,
    query: firstValues(new URL(request.url).searchParams),
    body,
    clientIp: getClientIp(request) ?? null,
  });
  return callbackResponse(result);
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<Response> {
  return handle(request, params.provider, 'GET', null);
}

export async function action({ request, params }: ActionFunctionArgs): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { ...BASE_HEADERS, Allow: 'GET, POST' } });
  }
  const form = await readCallbackForm(request);
  if (!form.ok) return page(413, 'Sign-in failed', 'The identity provider sent too much data.');
  return handle(request, params.provider, 'POST', form.body);
}
