import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { warmUpViteDevServer } from '../global-setup';
import { BASE_URL_MCP, BASE_URL_WEB } from '../playwright.config';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { callTool, connectBearer, mcpClient, mcpEra, MODERN_PROTOCOL, rawInitialize, requireSmokeKey } from './helpers/mcp';
import { userIdByEmail } from './helpers/seed';

/**
 * `/mcp` keeps no state between requests, in the project's protocol era:
 *   (1) the drobek container restarts in the middle of the agent loop and the
 *       SAME client (no new connect) writes the next version;
 *   (2) a write_files request body over 5 MiB passes the whole chain (the TLS
 *       proxy, MCP_MAX_BODY_BYTES, the SDK's own 4 MiB read limit unused);
 *   (3) revoking the OAuth connection in /me/connections fails the client's
 *       next request with 401, and a new OAuth flow connects again;
 *   (4) initialize answers without an Mcp-Session-Id; a client still sending
 *       one from an older release is served; GET and DELETE answer 405
 *       (through the proxy, not a 502); a client in `auto` negotiation speaks
 *       2026-07-28 (the access log's `protocol`); a revoked API key fails its
 *       next request while another key of the same user goes on;
 *   (5) @smoke: a 2026-07-28 tools/list carries the cache hint, a 2025
 *       initialize the instructions.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Restart the drobek container (the dev stack or the image flow's project) and wait until it serves again. */
async function restartDrobek(request: APIRequestContext): Promise<void> {
  execFileSync('docker', ['compose', 'restart', 'drobek'], { cwd: repoRoot, stdio: 'pipe', timeout: 120_000 });
  await expect
    .poll(
      async () => {
        try {
          return (await request.get(`${BASE_URL_WEB}/healthz`, { timeout: 5_000 })).status();
        } catch {
          return 0;
        }
      },
      { timeout: 180_000, intervals: [1_000] }
    )
    .toBe(200);
  await warmUpViteDevServer(BASE_URL_WEB);
}

/** The server's `mcp request` access-log lines since `sinceIso` for one user. */
function accessLog(sinceIso: string, userId: string): Record<string, unknown>[] {
  const out = execFileSync('docker', ['compose', 'logs', '--no-color', '--no-log-prefix', '--since', sinceIso, 'drobek'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .filter((l) => l.includes('"mcp request"') && l.includes(userId))
    .flatMap((l) => {
      try {
        return [JSON.parse(l.slice(l.indexOf('{'))) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

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

/** Text files whose JSON encoding is twice their size: a request body over 5 MiB, the app under its 5 MiB total. */
function quoteHeavyFiles(): { path: string; content: string }[] {
  const content = `${'"'.repeat(99)}\n`.repeat(4_800);
  return [0, 1, 2, 3, 4, 5].map((i) => ({ path: `notes/quotes-${i}.txt`, content }));
}

test('MCP without sessions: a restart mid-loop, a 5 MiB write, a revoked OAuth connection and a new flow @local', async ({ page, request }) => {
  skipUnlessLocal();
  test.setTimeout(300_000);
  const mcp = await mcpClient(page, request, { tag: 'mcp-restart' });
  expect(mcp.client.getProtocolEra()).toBe(mcpEra());

  // (1) The loop survives a restart with the same client instance.
  const created = await callTool(mcp.client, 'create_app', { name: 'Stateless Restart E2E', template: 'html' });
  expect(created.isError, created.text).toBe(false);
  const appId = created.json.app_id as string;
  const before = await callTool(mcp.client, 'write_files', {
    app_id: appId,
    files: [{ path: 'index.html', content: '<!doctype html><title>before</title><p>before the restart</p>\n' }],
    reasoning: 'Before the restart',
  });
  expect(before.isError, before.text).toBe(false);
  expect(before.json).toMatchObject({ version: 2, compile: { ok: true } });

  await restartDrobek(request);

  const after = await callTool(mcp.client, 'write_files', {
    app_id: appId,
    files: [{ path: 'index.html', content: '<!doctype html><title>after</title><p>after the restart</p>\n' }],
    reasoning: 'After the restart',
  });
  expect(after.isError, after.text).toBe(false);
  expect(after.json).toMatchObject({ version: 3, compile: { ok: true } });

  // (2) A body over 5 MiB, written and compiled.
  const files = quoteHeavyFiles();
  const args = { app_id: appId, files, reasoning: 'A write whose request body is over 5 MiB' };
  expect(Buffer.byteLength(JSON.stringify(args))).toBeGreaterThan(5 * 1024 * 1024);
  expect(files.reduce((sum, f) => sum + f.content.length, 0)).toBeLessThan(3 * 1024 * 1024);
  const big = await callTool(mcp.client, 'write_files', args);
  expect(big.isError, big.text.slice(0, 500)).toBe(false);
  expect(big.json).toMatchObject({ version: 4, compile: { ok: true } });

  // (3) Revoking the connection fails the next request; a new OAuth flow works.
  await page.goto('/me/connections');
  await page.locator('[data-testid="connection-row"]').getByTestId('connection-revoke').click();
  await expect(page.getByTestId('connections-empty')).toBeVisible();
  await expect(mcp.client.callTool({ name: 'list_apps', arguments: {} })).rejects.toMatchObject({ status: 401 });

  const again = await mcpClient(page, request, { email: mcp.email, signedIn: true });
  try {
    const listed = await callTool(again.client, 'list_apps', {});
    expect(listed.isError, listed.text).toBe(false);
    expect((listed.json.apps as { app_id: string }[]).map((a) => a.app_id)).toContain(appId);
  } finally {
    await again.client.close();
    await mcp.client.close();
  }
});

test('MCP without sessions: no session id, an old one is ignored, GET/DELETE 405, auto speaks 2026-07-28, a revoked key fails its next request @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('mcp-stateless');
  await loginViaEmail(page, request, email);
  const doomed = await createReadKey(page, 'stateless key A');
  const kept = await createReadKey(page, 'stateless key B');

  // initialize opens nothing.
  const init = await rawInitialize(request, { Authorization: `Bearer ${doomed.key}` });
  expect(init.status()).toBe(200);
  expect(init.headers()['mcp-session-id']).toBeUndefined();

  // A session id from before the upgrade changes nothing.
  const stale = await connectBearer(doomed.key, { headers: { 'mcp-session-id': '5f8a7c3e-0d4b-4c1e-9a7f-2b6d8e1c3a90' } });
  const listed = await callTool(stale.client, 'list_apps', {});
  expect(listed.isError, listed.text).toBe(false);
  expect(listed.json.user).toEqual({ email });

  // No listen stream and nothing to delete over GET / DELETE, also through the proxy.
  for (const method of ['GET', 'DELETE'] as const) {
    const res = await request.fetch(`${BASE_URL_MCP}/mcp`, {
      method,
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${doomed.key}` },
    });
    expect(res.status(), method).toBe(405);
    expect(res.headers()['allow'], method).toBe('POST');
  }

  // `auto` negotiation lands on 2026-07-28, and the access log says so.
  const since = new Date(Date.now() - 60_000).toISOString();
  const userId = await userIdByEmail(email);
  const auto = await connectBearer(kept.key, { era: 'auto' });
  expect(auto.client.getProtocolEra()).toBe('modern');
  expect(auto.client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL);
  const autoListed = await callTool(auto.client, 'list_apps', {});
  expect(autoListed.isError, autoListed.text).toBe(false);
  await expect
    .poll(() => accessLog(since, userId).filter((l) => l.tool === 'list_apps').map((l) => l.protocol), { timeout: 10_000 })
    .toContain(MODERN_PROTOCOL);

  // Revoking key A in the dashboard: its next request is refused, key B goes on.
  await page.goto('/me/api-keys');
  await page.locator(`[data-testid="api-key-row"][data-key-id="${doomed.id}"]`).getByTestId('api-key-revoke').click();
  await expect(page.locator(`[data-testid="api-key-row"][data-key-id="${doomed.id}"]`)).toHaveAttribute('data-status', 'revoked');
  await expect(stale.client.callTool({ name: 'list_apps', arguments: {} })).rejects.toMatchObject({ status: 401 });
  const goesOn = await callTool(auto.client, 'list_apps', {});
  expect(goesOn.isError, goesOn.text).toBe(false);
  await stale.client.close();
  await auto.client.close();
});

test('MCP smoke: a 2026-07-28 tools/list carries the private cache hint, a 2025 initialize the instructions @smoke', async () => {
  const key = await requireSmokeKey();

  const modern = await connectBearer(key, { era: 'modern' });
  try {
    expect(modern.client.getProtocolEra()).toBe('modern');
    const listed = (await modern.client.listTools(undefined, { cacheMode: 'bypass' })) as Awaited<
      ReturnType<typeof modern.client.listTools>
    > & { ttlMs?: number; cacheScope?: string };
    expect(listed.tools.map((t) => t.name)).toContain('list_apps');
    expect(listed.ttlMs).toBeGreaterThan(0);
    expect(listed.cacheScope).toBe('private');
  } finally {
    await modern.client.close();
  }

  const legacy = await connectBearer(key, { era: 'legacy' });
  try {
    expect(legacy.client.getProtocolEra()).toBe('legacy');
    expect(legacy.client.getInstructions() ?? '').toContain('list_apps');
  } finally {
    await legacy.client.close();
  }
});
