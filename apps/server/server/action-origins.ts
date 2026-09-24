import type { ServerBuild } from 'react-router';

/**
 * React Router ≥ 7.15 refuses an action (a form POST, `*.data`) whose `Origin`
 * header does not match the origin of `request.url` — "Bad Request" 400 for
 * every sign-in and dashboard form. Behind the TLS proxy (Caddy) drobek sees
 * plain HTTP and does not trust `X-Forwarded-Proto` (only `X-Real-IP` through
 * `TRUST_PROXY`), so `@react-router/express` builds `http://drobek.app/...`
 * while the browser sends `Origin: https://drobek.app`.
 *
 * The dashboard's public origin is configuration (`PUBLIC_APP_URL`), so its
 * host is added to the build's `allowedActionOrigins` at runtime: the same
 * host is accepted whatever the scheme the proxy hop used. Any other origin
 * is still refused. Without a valid `PUBLIC_APP_URL` the build is unchanged.
 */
export function withPublicActionOrigin(build: ServerBuild, env: NodeJS.ProcessEnv = process.env): ServerBuild {
  const raw = env.PUBLIC_APP_URL?.trim();
  if (!raw) return build;
  let host: string;
  try {
    host = new URL(raw).host;
  } catch {
    return build;
  }
  if (!host) return build;
  const existing = Array.isArray(build.allowedActionOrigins) ? build.allowedActionOrigins : [];
  if (build.allowedActionOrigins === false || existing.includes(host)) return build;
  return { ...build, allowedActionOrigins: [...existing, host] };
}
