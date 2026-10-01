import { describe, expect, it } from 'vitest';
import { mascotSvg } from '@drobek/email/mascot';
import { ROBOTS_TXT, faviconLoader, robotsTxtLoader } from './site-files.server.js';

describe('dashboard site files', () => {
  it('robots.txt allows the landing page and keeps crawlers out of the private areas', async () => {
    const res = robotsTxtLoader();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await res.text();
    expect(body).toBe(ROBOTS_TXT);
    const lines = body.split('\n');
    expect(lines[0]).toBe('User-agent: *');
    for (const allowed of ['/$', '/login$', '/build-with-your-agent']) expect(lines).toContain(`Allow: ${allowed}`);
    for (const blocked of ['/workspaces', '/admin', '/oauth', '/mcp', '/auth']) expect(lines).toContain(`Disallow: ${blocked}`);
    expect(lines).not.toContain('Disallow: /');
  });

  it('favicon.ico answers the mascot SVG', async () => {
    const res = faviconLoader();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('cache-control')).toContain('max-age=');
    expect(await res.text()).toBe(mascotSvg());
  });
});
