import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL_MCP } from '../playwright.config';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { rawInitialize } from './helpers/mcp';

/**
 * The MCP sessions of one user on the stack (default limits):
 *   (1) past MCP_SESSIONS_PER_USER (10) open sessions, a new one closes the
 *       user's least recently used: its id answers 404 "MCP session not
 *       found", after which a client initializes a new session; the others
 *       keep working;
 *   (2) a session is driven only by the API key that opened it — another key
 *       of the same user and scope gets 401;
 *   (3) revoking that key in the dashboard closes its session: the other
 *       key's request with its id answers 404 instead of 401.
 * The idle TTL (MCP_SESSION_IDLE_TTL_MS, 1 hour) is covered by the unit tests.
 */

const SESSIONS_PER_USER = 10;
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

/** initialize + notifications/initialized; the new session's id. */
async function openSession(request: APIRequestContext, key: string): Promise<string> {
  const init = await rawInitialize(request, { Authorization: `Bearer ${key}` });
  expect(init.status()).toBe(200);
  const sid = init.headers()['mcp-session-id'];
  expect(sid, 'initialize returns a session id').toBeTruthy();
  const ready = await request.post(`${BASE_URL_MCP}/mcp`, {
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}`, 'mcp-session-id': sid },
    data: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  expect(ready.status()).toBe(202);
  return sid;
}

async function ping(request: APIRequestContext, key: string, sid: string): Promise<{ status: number; body: string }> {
  const res = await request.post(`${BASE_URL_MCP}/mcp`, {
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}`, 'mcp-session-id': sid },
    data: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });
  return { status: res.status(), body: await res.text() };
}

test('MCP sessions: the per-user cap closes the least recently used, a session keeps to its key, revoking the key closes it @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  await loginViaEmail(page, request, uniqueEmail('mcp-sessions'));
  const first = await createReadKey(page, 'sessions key A');
  const second = await createReadKey(page, 'sessions key B');

  // (1) The cap: the oldest of SESSIONS_PER_USER + 1 sessions is closed.
  const capped: string[] = [];
  for (let i = 0; i <= SESSIONS_PER_USER; i += 1) capped.push(await openSession(request, second.key));
  const evicted = await ping(request, second.key, capped[0]);
  expect(evicted.status).toBe(404);
  expect(evicted.body).toContain('MCP session not found');
  for (const sid of capped.slice(1)) expect((await ping(request, second.key, sid)).status).toBe(200);

  // (2) A session keeps to the key that opened it. Opening it closes the
  // least recently used of key B's sessions (the cap again).
  const own = await openSession(request, first.key);
  expect((await ping(request, first.key, own)).status).toBe(200);
  const foreign = await ping(request, second.key, own);
  expect(foreign.status).toBe(401);
  expect(foreign.body).toContain('Token does not match this MCP session.');

  // (3) Revoking key A in the dashboard closes its session.
  await page.goto('/me/api-keys');
  await page.locator(`[data-testid="api-key-row"][data-key-id="${first.id}"]`).getByTestId('api-key-revoke').click();
  await expect(page.locator(`[data-testid="api-key-row"][data-key-id="${first.id}"]`)).toHaveAttribute('data-status', 'revoked');
  expect((await ping(request, first.key, own)).status).toBe(401);
  await expect.poll(async () => (await ping(request, second.key, own)).status, { timeout: 5_000 }).toBe(404);
});
