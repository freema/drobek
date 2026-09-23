import { randomBytes, randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { APPS_URL_SCHEME } from '../playwright.config';
import { hostRequest, previewHost, prodHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';

/**
 * NSO-315 acceptance, end to end against the local compose stack:
 *   - an unknown slug is a 404 "no app" page (cached as a miss for 30 s) —
 *     and an app created under that very slug is served on the NEXT request
 *     (create_app announces a `create` app-changed event that drops the miss);
 *   - past APPS_UNKNOWN_HOST_LIMIT (default 60) "no app" answers per client
 *     IP per window, the apps origin answers 429 with a tiny plain-text body.
 * The limit part needs a client IP the server believes: on the plain-http dev
 * stack an explicit X-Real-IP is honoured (TRUST_PROXY unset), so the spec
 * uses a random TEST-NET-2 address nobody else shares. Behind Caddy
 * (TRUST_PROXY=x-real-ip, https) every spec would share Caddy's view of the
 * runner's IP, so that part is skipped there — throttling it would 429 the
 * other specs' unknown-host checks.
 */

test('unknown app hosts: a cached miss never hides a newly created app @local', async ({ page, request }) => {
  skipUnlessLocal();
  const a = await mcpClient(page, request, { tag: 'unknown-host' });
  try {
    const slug = `late-ghost-${randomBytes(4).toString('hex')}`;
    // Twice: the second answer comes from the negative cache — same page, same headers.
    for (let i = 0; i < 2; i++) {
      const miss = await hostRequest(previewHost(slug));
      expect(miss.status).toBe(404);
      expect(miss.body).toContain('There is no app at this address.');
      expect(miss.headers['content-type']).toMatch(/^text\/html/);
      expect(miss.headers['cache-control']).toBe('no-store');
      expect(miss.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
    expect((await hostRequest(prodHost(slug))).status).toBe(404);

    const created = await callTool(a.client, 'create_app', { name: slug });
    expect(created.isError, created.text).toBe(false);
    expect(created.json.slug).toBe(slug);

    const hit = await hostRequest(previewHost(slug));
    expect(hit.status).toBe(200);
    expect(hit.body).toContain('<script type="module" src="/main.js"></script>');
    const prod = await hostRequest(prodHost(slug));
    expect(prod.status).toBe(404);
    expect(prod.body).toContain('Not published yet');
  } finally {
    await a.transport.close();
  }
});

test('unknown app hosts: per-IP limit answers 429 @local', async () => {
  skipUnlessLocal();
  test.skip(APPS_URL_SCHEME !== 'http', 'needs the plain-http dev stack (client X-Real-IP honoured)');
  const ip = `198.51.100.${randomInt(1, 255)}`;
  const run = randomBytes(3).toString('hex');
  const headers = { 'X-Real-IP': ip };
  let first429 = -1;
  for (let i = 0; i < 70 && first429 === -1; i++) {
    const r = await hostRequest(prodHost(`nope-${run}-${i}`), '/', { headers });
    if (r.status === 429) first429 = i;
    else expect(r.status).toBe(404);
  }
  // The default budget (60) is used up, and not a request earlier.
  expect(first429).toBe(60);

  const throttled = await hostRequest(prodHost(`nope-${run}-again`), '/', { headers });
  expect(throttled.status).toBe(429);
  expect(throttled.body).toBe('Too Many Requests');
  expect(throttled.headers['content-type']).toBe('text/plain; charset=utf-8');
  expect(throttled.headers['cache-control']).toBe('no-store');
  expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
  expect(throttled.headers['content-security-policy']).toContain("frame-ancestors 'none'");

  // Another client is not affected.
  const other = await hostRequest(prodHost(`nope-${run}-other`), '/', {
    headers: { 'X-Real-IP': `198.51.100.${(Number(ip.split('.')[3]) % 254) + 1}` },
  });
  expect(other.status).toBe(404);
});
