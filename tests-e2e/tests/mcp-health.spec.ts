import { expect, test } from '@playwright/test';
import { BASE_URL_MCP } from '../playwright.config';

// D3: the MCP liveness path is /health, NOT /healthz.
test('mcp server health responds ok @smoke', async ({ request }) => {
  const res = await request.get(`${BASE_URL_MCP}/health`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
