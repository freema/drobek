import { randomBytes, randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { APPS_DOMAIN } from '../playwright.config';
import { directRequest, hostRequest, previewHost, prodHost, versionHost } from './helpers/apps-host';
import { ownClientIpHeaders, skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import { tlsAsk } from './helpers/tls-ask';

/**
 * Unknown app hosts end to end against both local stacks:
 *   - an unknown slug is a 404 "no app" page (cached as a miss for 30 s) —
 *     and an app created under that very slug is served on the NEXT request
 *     (create_app announces a `create` app-changed event that drops the miss);
 *   - past APPS_UNKNOWN_HOST_LIMIT (default 60) "no app" answers per client
 *     IP per window, the apps origin answers 429 with a tiny plain-text body;
 *   - a version host of a live app whose version does not exist is a 404
 *     counted against the same budget (429 past it, while the versions the
 *     cache knows keep serving), and Caddy's TLS ask refuses it a certificate.
 * The limit parts need a client IP nobody else shares, so they go straight to
 * drobek (DROBEK_URL) with the X-Real-IP a proxy sets — a random TEST-NET-2
 * address: the dev stack honours it (TRUST_PROXY unset), the image flow too
 * (TRUST_PROXY=x-real-ip; Caddy would overwrite it with the runner's IP that
 * every spec shares, and throttling that would 429 the other specs).
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
  const ip = `198.51.100.${randomInt(1, 255)}`;
  const run = randomBytes(3).toString('hex');
  const headers = { 'X-Real-IP': ip };
  let first429 = -1;
  for (let i = 0; i < 70 && first429 === -1; i++) {
    const r = await directRequest(prodHost(`nope-${run}-${i}`), '/', { headers });
    if (r.status === 429) first429 = i;
    else expect(r.status).toBe(404);
  }
  // The default budget (60) is used up, and not a request earlier.
  expect(first429).toBe(60);

  const throttled = await directRequest(prodHost(`nope-${run}-again`), '/', { headers });
  expect(throttled.status).toBe(429);
  expect(throttled.body).toBe('Too Many Requests');
  expect(throttled.headers['content-type']).toBe('text/plain; charset=utf-8');
  expect(throttled.headers['cache-control']).toBe('no-store');
  expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
  expect(throttled.headers['content-security-policy']).toContain("frame-ancestors 'none'");

  // Another client is not affected.
  const other = await directRequest(prodHost(`nope-${run}-other`), '/', {
    headers: { 'X-Real-IP': `198.51.100.${(Number(ip.split('.')[3]) % 254) + 1}` },
  });
  expect(other.status).toBe(404);
});

test('version hosts: a missing version is a counted 404 and gets no certificate @local', async ({ page, request }) => {
  skipUnlessLocal();
  const a = await mcpClient(page, request, { tag: 'unknown-version' });
  try {
    const created = await callTool(a.client, 'create_app', { name: `ghost-versions-${randomBytes(4).toString('hex')}` });
    expect(created.isError, created.text).toBe(false);
    const slug = created.json.slug as string;

    expect((await hostRequest(versionHost(slug, 1))).status).toBe(200);
    for (const n of [2, 999_999_999]) {
      const miss = await hostRequest(versionHost(slug, n));
      expect(miss.status).toBe(404);
      expect(miss.body).toContain('This version does not exist or did not compile.');
      expect(miss.headers['x-drobek-app']).toBe(slug);
    }

    await test.step("Caddy's ask: a certificate only for a version the app has", async () => {
      const domain = APPS_DOMAIN.replace(/:\d+$/, '');
      expect(await tlsAsk(`${slug}.${domain}`)).toBe(200);
      expect(await tlsAsk(`${slug}--v1.${domain}`)).toBe(200);
      expect(await tlsAsk(`${slug}--v2.${domain}`)).toBe(404);
      expect(await tlsAsk(`${slug}--v999999999.${domain}`)).toBe(404);
    });

    await test.step('missing versions count against the per-IP budget', async () => {
      const headers = ownClientIpHeaders();
      let first429 = -1;
      for (let i = 0; i < 70 && first429 === -1; i++) {
        const r = await directRequest(versionHost(slug, 1_000 + i), '/', { headers });
        if (r.status === 429) first429 = i;
        else expect(r.status).toBe(404);
      }
      expect(first429).toBe(60);
      const throttled = await directRequest(versionHost(slug, 5_000), '/', { headers });
      expect(throttled.status).toBe(429);
      expect(throttled.body).toBe('Too Many Requests');
      // The version the serve cache knows (refreshed by a request without a per-IP bucket) still serves the throttled client.
      expect((await directRequest(versionHost(slug, 1))).status).toBe(200);
      expect((await directRequest(versionHost(slug, 1), '/', { headers })).status).toBe(200);
    });
  } finally {
    await a.transport.close();
  }
});
