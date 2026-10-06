import { createHmac, randomBytes } from 'node:crypto';
import { expect, test, type BrowserContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * The built-in platform module `webhooks` end to end (DROBEK_MODULES=…,webhooks
 * in the composes):
 *
 *  - a `payments` collection and an endpoint into it — the endpoint waits for
 *    the owner, and configure_module names the secret still missing;
 *  - a delivery before the secret is set → 503, logged;
 *  - the secret set in the dashboard (never over MCP): the module page shows
 *    the endpoint address and "set";
 *  - a signed POST → 200 with the record id, the record in the collection
 *    (query_data); the same event id again → duplicate, nothing stored;
 *  - a wrong signature → 401 invalid_signature, a rejected row in
 *    get_logs kind "webhooks" (inside the untrusted envelope) and on the
 *    module page; no answer carries the secret or a body.
 */

interface Created {
  app_id: string;
  slug: string;
}

const SECRET = ['whsec', 'e2e', randomBytes(12).toString('hex')].join('-');
const MARKER = `marker-${randomBytes(6).toString('hex')}`;

const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');

async function configure(mcp: McpClient, owner: BrowserContext, appId: string, module: string, config: unknown) {
  const r = await callTool(mcp.client, 'configure_module', { app_id: appId, module, config });
  expect(r.isError, JSON.stringify(r.json)).toBe(false);
  if (r.json.applied === false) {
    const ok = await owner.request.post(`${BASE_URL_WEB}/api/apps/${appId}/modules/${module}/confirm`, {
      headers: { Origin: BASE_URL_WEB },
      maxRedirects: 0,
    });
    expect(ok.status(), await ok.text()).toBe(200);
  }
  return r;
}

function deliver(slug: string, body: string, headers: Record<string, string>) {
  return hostRequest(previewHost(slug), '/__drobek/v1/webhooks/payments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers },
    body,
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('platform module webhooks — signed deliveries into a data collection @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let ws: string;
  let app: Created;
  const answers: string[] = [];

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  test('an endpoint waits for the owner and names its missing secret; before the secret a delivery is 503', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'webhooks-module', scope: FULL_SCOPE });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });
    ws = mcp.workspace;

    const info = await callTool(mcp.client, 'skill_info', { name: 'webhooks' });
    expect(info.isError, JSON.stringify(info.json)).toBe(false);
    expect(info.json).toMatchObject({ name: 'webhooks', kind: 'module' });

    app = (await callTool(mcp.client, 'create_app', { name: 'Payments inbox', template: 'react-ts' })).json as unknown as Created;
    await configure(mcp, owner, app.app_id, 'data', {
      collections: { payments: { rules: { read: 'admin', create: 'none', update: 'none', delete: 'admin' } } },
    });
    const held = await callTool(mcp.client, 'configure_module', {
      app_id: app.app_id,
      module: 'webhooks',
      config: { endpoints: { payments: { collection: 'payments', verify: 'hmac-sha256' } } },
    });
    expect(held.isError, JSON.stringify(held.json)).toBe(false);
    expect(held.json.applied).toBe(false);
    expect(held.json.secrets_missing).toEqual(['WEBHOOK_SECRET_PAYMENTS']);
    await configure(mcp, owner, app.app_id, 'webhooks', { endpoints: { payments: { collection: 'payments', verify: 'hmac-sha256' } } });
    answers.push(held.text, JSON.stringify(held.json));

    const body = JSON.stringify({ type: 'early', marker: MARKER });
    const early = await deliver(app.slug, body, { 'x-webhook-signature': sign(body) });
    expect(early.status, early.body).toBe(503);
    expect(JSON.parse(early.body)).toMatchObject({ error: 'webhook_secret_not_set' });
  });

  test('the secret is set in the dashboard; the module page shows the address and the status', async () => {
    skipUnlessLocal();
    const p = await owner.newPage();
    await p.goto(`/workspaces/${ws}/apps/${app.slug}/modules/webhooks`);
    await expect(p.getByTestId('webhook-url-payments')).toContainText('/__drobek/v1/webhooks/payments');
    await expect(p.getByTestId('webhook-secret-payments')).toContainText('not set');
    const row = p.locator('[data-testid="secret-row"][data-name="WEBHOOK_SECRET_PAYMENTS"]');
    await row.getByTestId('secret-input-WEBHOOK_SECRET_PAYMENTS').fill(SECRET);
    await row.getByTestId('secret-set-WEBHOOK_SECRET_PAYMENTS').click();
    await expect(p.getByTestId('done-notice')).toHaveAttribute('data-done', 'secret-set');
    await expect(row.getByTestId('secret-status')).toHaveText('set');
    await expect(p.getByTestId('webhook-secret-payments')).not.toContainText('not set');
    expect(await p.content()).not.toContain(SECRET);
    await p.close();
  });

  test('a signed delivery is stored as a record; a retry of the same event is a duplicate', async () => {
    skipUnlessLocal();
    const body = JSON.stringify({ type: 'payment.succeeded', amount: 1200, marker: MARKER });
    const headers = { 'x-webhook-signature': `sha256=${sign(body)}`, 'webhook-id': 'evt_e2e_1' };
    const ok = await deliver(app.slug, body, headers);
    expect(ok.status, ok.body).toBe(200);
    const stored = JSON.parse(ok.body) as { ok: boolean; id: string };
    expect(stored.ok).toBe(true);
    expect(typeof stored.id).toBe('string');

    const again = await deliver(app.slug, body, headers);
    expect(again.status, again.body).toBe(200);
    expect(JSON.parse(again.body)).toEqual({ ok: true, duplicate: true });

    const q = await callTool(mcp.client, 'query_data', { app_id: app.app_id, collection: 'payments' });
    expect(q.isError, JSON.stringify(q.json)).toBe(false);
    expect(q.json).toMatchObject({ total: 1 });
    const rec = (q.json.records as Record<string, unknown>[])[0];
    expect(rec).toMatchObject({ source: 'payments', event_type: 'payment.succeeded', event_id: 'evt_e2e_1', payload: { amount: 1200 } });
    answers.push(q.text);
  });

  test('a wrong signature is 401, listed in get_logs kind "webhooks" and on the module page; no answer carries the secret', async () => {
    skipUnlessLocal();
    const body = JSON.stringify({ type: 'payment.succeeded', marker: MARKER });
    const bad = await deliver(app.slug, body, { 'x-webhook-signature': sign(body, `${SECRET}-wrong`) });
    expect(bad.status, bad.body).toBe(401);
    expect(JSON.parse(bad.body)).toMatchObject({ error: 'invalid_signature', details: { reason: 'bad_signature' } });

    const logs = await callTool(mcp.client, 'get_logs', { app_id: app.app_id, kind: 'webhooks' });
    expect(logs.isError, JSON.stringify(logs.json)).toBe(false);
    expect(logs.text.startsWith('UNTRUSTED CONTENT:')).toBe(true);
    const entries = logs.json.entries as { endpoint: string; status: string; reason: string | null }[];
    expect(entries.map((e) => e.status)).toEqual(['rejected_signature', 'duplicate', 'accepted', 'rejected_signature']);
    expect(entries[0]).toMatchObject({ endpoint: 'payments', reason: 'bad_signature' });
    expect(logs.text).not.toContain(MARKER);
    answers.push(logs.text);

    const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    const hooks = (got.json.modules as Record<string, { info?: { endpoints: Record<string, unknown>[] }; secrets?: { name: string; hasSecret: boolean }[] }>).webhooks;
    expect(hooks.info?.endpoints[0]).toMatchObject({ name: 'payments', collection: 'payments', verify: 'hmac-sha256', last_status: 'rejected_signature' });
    expect(hooks.secrets).toEqual([expect.objectContaining({ name: 'WEBHOOK_SECRET_PAYMENTS', hasSecret: true })]);
    answers.push(got.text, JSON.stringify(got.json));

    const p = await owner.newPage();
    await p.goto(`/workspaces/${ws}/apps/${app.slug}/modules/webhooks`);
    await expect(p.locator('[data-testid="webhook-deliveries"] tr[data-status="rejected_signature"]').first()).toContainText('the signature does not match');
    await expect(p.locator('[data-testid="webhook-deliveries"] tr[data-status="accepted"]')).toHaveCount(1);
    expect(await p.content()).not.toContain(MARKER);
    await p.close();

    for (const a of answers) expect(a).not.toContain(SECRET);
  });
});
