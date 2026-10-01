/**
 * The dashboard host's well-known files: `GET /robots.txt` and
 * `GET /favicon.ico`. App hosts never reach these routes (the app-host
 * dispatcher answers them first), so an app serves its own robots.txt.
 */
import { mascotSvg } from '@drobek/email/mascot';

/**
 * Crawlers may read the landing page with the public gallery, the sign-in
 * page and the agent docs; the signed-in areas, the OAuth and MCP endpoints
 * and the gallery's counting links are off limits.
 */
export const ROBOTS_TXT = [
  'User-agent: *',
  'Allow: /$',
  'Allow: /login$',
  'Allow: /build-with-your-agent',
  'Allow: /llms.txt',
  'Allow: /llms-full.txt',
  'Disallow: /workspaces',
  'Disallow: /admin',
  'Disallow: /oauth',
  'Disallow: /mcp',
  'Disallow: /auth',
  'Disallow: /me',
  'Disallow: /invite',
  'Disallow: /login/',
  'Disallow: /api/',
  'Disallow: /gallery/',
  'Disallow: /duplicate/',
  'Disallow: /report',
  'Disallow: /__drobek/',
  '',
].join('\n');

export function robotsTxtLoader(): Response {
  return new Response(ROBOTS_TXT, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** The dashboard's icon: the mascot, the same SVG as the pages' `<link rel="icon">`. */
export function faviconLoader(): Response {
  return new Response(mascotSvg(), {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
