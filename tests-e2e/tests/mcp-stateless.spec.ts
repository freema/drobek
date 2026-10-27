import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL_MCP } from '../playwright.config';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { rawInitialize } from './helpers/mcp';

/**
 * `/mcp` keeps no state between requests (the stack's defaults):
 *   (1) initialize answers without an Mcp-Session-Id, and a request after it
 *       needs none;
 *   (2) a request that still carries a session id from an older release is
 *       served like any other;
 *   (3) GET and DELETE answer 405;
 *   (4) revoking an API key in the dashboard fails that key's very next
 *       request with 401, while another key of the same user goes on.
 */

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

/** Create a read-only key on /me/api-keys and return it with its row id. */
async function createReadKey(page: Page, name: string): Promise<{ id: string; key: string }> {
  await page.goto('/me/api-keys');
  await page.getByTestId('api-key-name').fill(name);
  await page.getByTestId('api-key-scope-write').uncheck();
  await page.getByTestId('api-key-create').click();
  const created = page.getByTestId('api-key-created');
  await expect(created).toContainText(name);
  const id = (await created.getAttribute('data-key-id')) ?? '';
  const key = (await page.getByTestId('api-key-value').textContent())?.trim() ?? '';
  expect(key).toMatch(/^drk_/);
  return { id, key };
}

async function listTools(request: APIRequestContext, key: string, extra: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const res = await request.post(`${BASE_URL_MCP}/mcp`, {
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}`, 'MCP-Protocol-Version': '2025-06-18', ...extra },
    data: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  });
  return { status: res.status(), body: await res.text() };
}

test('MCP without sessions: no session id, an old one is ignored, GET/DELETE 405, a revoked key fails its next request @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  await loginViaEmail(page, request, uniqueEmail('mcp-stateless'));
  const doomed = await createReadKey(page, 'stateless key A');
  const kept = await createReadKey(page, 'stateless key B');

  // (1) initialize opens nothing; the next request stands on its own.
  const init = await rawInitialize(request, { Authorization: `Bearer ${doomed.key}` });
  expect(init.status()).toBe(200);
  expect(init.headers()['mcp-session-id']).toBeUndefined();
  expect(await init.text()).toContain('"instructions"');
  const listed = await listTools(request, doomed.key);
  expect(listed.status).toBe(200);
  expect(listed.body).toContain('list_apps');

  // (2) A session id from before the upgrade changes nothing.
  const stale = await listTools(request, doomed.key, { 'mcp-session-id': '5f8a7c3e-0d4b-4c1e-9a7f-2b6d8e1c3a90' });
  expect(stale.status).toBe(200);
  expect(stale.body).toContain('list_apps');

  // (3) No listen stream and nothing to delete in the 2025 era.
  for (const method of ['GET', 'DELETE'] as const) {
    const res = await request.fetch(`${BASE_URL_MCP}/mcp`, {
      method,
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${doomed.key}` },
    });
    expect(res.status(), method).toBe(405);
    expect(res.headers()['allow'], method).toBe('POST');
  }

  // (4) Revoking key A in the dashboard: its next request is refused, key B goes on.
  await page.goto('/me/api-keys');
  await page.locator(`[data-testid="api-key-row"][data-key-id="${doomed.id}"]`).getByTestId('api-key-revoke').click();
  await expect(page.locator(`[data-testid="api-key-row"][data-key-id="${doomed.id}"]`)).toHaveAttribute('data-status', 'revoked');
  expect((await listTools(request, doomed.key)).status).toBe(401);
  expect((await listTools(request, kept.key)).status).toBe(200);
});
