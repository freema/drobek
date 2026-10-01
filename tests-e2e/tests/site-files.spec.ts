import { expect, test } from '@playwright/test';

test('GET /robots.txt → the dashboard default @smoke', async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/plain');
  const lines = (await res.text()).split('\n');
  expect(lines[0]).toBe('User-agent: *');
  expect(lines).toContain('Allow: /$');
  for (const blocked of ['/workspaces', '/admin', '/oauth', '/mcp', '/auth']) expect(lines).toContain(`Disallow: ${blocked}`);
});

test('GET /favicon.ico → the dashboard icon @smoke', async ({ request }) => {
  const res = await request.get('/favicon.ico');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/svg+xml');
  expect(await res.text()).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});
