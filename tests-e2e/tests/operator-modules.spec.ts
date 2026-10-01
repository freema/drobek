import { expect, test } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost } from './helpers/apps-host';
import { loginViaEmail, skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import { personalWorkspaceOf } from './helpers/seed';

/**
 * An operator-only module: the installed e2e fixture `opsprobe`
 * (tests-e2e/fixtures/drobek-module-ops-probe — no skill, only an error
 * reporter, an e-mail transport and a server job). It is active on the
 * server, yet an app owner and their agent never meet it:
 *  - MCP: skill_info lists it nowhere and answers its name like an unknown
 *    one; create_app / get_app (skills, modules, the briefing) never name it;
 *    configure_module does not know it;
 *  - /llms.txt and /llms-full.txt never name it; its app routes do not exist;
 *  - the dashboard: no row on the app's Modules tab, no module page, no card
 *    on the workspace Modules page.
 * A super-admin sees its card on the workspace Modules page, marked
 * operator-only; /healthz and /api/version list it with `operatorOnly: true`.
 */

const MODULE = 'opsprobe';
const SUPER_ADMIN = 'e2e-superadmin@drobek.test';

test('healthz and api/version list the operator-only module with operatorOnly: true @local', async ({ request }) => {
  skipUnlessLocal();
  const health = await (await request.get('/healthz')).json();
  const version = await (await request.get('/api/version')).json();
  const entry = { name: MODULE, version: '1.0.0', source: 'dir', contract: '^1.2', operatorOnly: true };
  expect(health.modules).toContainEqual(entry);
  expect(version.modules).toContainEqual(entry);
  for (const m of health.modules as { name: string; operatorOnly?: boolean }[]) {
    if (m.name !== MODULE) expect(m.operatorOnly, m.name).toBeUndefined();
  }
});

test('an app owner and their agent never meet the operator-only module: MCP, llms.txt, app routes, dashboard @local', async ({ page, request }) => {
  skipUnlessLocal();
  const mcp = await mcpClient(page, request, { tag: 'operator-only' });
  try {
    const list = await callTool(mcp.client, 'skill_info', {});
    expect(list.isError, list.text).toBe(false);
    const names = (list.json.skills as { name: string }[]).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['hello', 'email', 'sync']));
    expect(names).not.toContain(MODULE);
    expect(list.text).not.toContain(MODULE);

    const one = await callTool(mcp.client, 'skill_info', { name: MODULE });
    expect(one.isError).toBe(true);
    expect(one.json).toMatchObject({ code: 'not_found', hint: 'skill_info()' });
    expect(one.json.available).toEqual(expect.arrayContaining(['hello', 'email']));
    expect(one.json.available).not.toContain(MODULE);
    // Nor as a contributor to the slot of the module that hosts it (email's email.transport).
    const email = await callTool(mcp.client, 'skill_info', { name: 'email' });
    expect(email.isError, email.text).toBe(false);
    const transport = (email.json.slots as { name: string; contributions: { module: string }[] }[]).find((s) => s.name === 'email.transport');
    expect(transport, 'email offers the email.transport slot').toBeTruthy();
    expect(transport!.contributions.map((c) => c.module)).not.toContain(MODULE);
    expect(email.text).not.toContain(MODULE);

    const created = await callTool(mcp.client, 'create_app', { name: 'Operator Quiet E2E', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const app = { app_id: created.json.app_id as string, slug: created.json.slug as string, workspace: created.json.workspace as string };
    expect((created.json.skills as { name: string }[]).map((s) => s.name)).toContain('email');
    expect(created.text).not.toContain(MODULE);

    const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    expect(got.isError, got.text).toBe(false);
    expect(Object.keys(got.json.modules as Record<string, unknown>)).toContain('email');
    expect(Object.keys(got.json.modules as Record<string, unknown>)).not.toContain(MODULE);
    expect(String(got.json.briefing)).toContain('`email`');
    expect(got.text).not.toContain(MODULE);

    const inApp = await callTool(mcp.client, 'skill_info', { app_id: app.app_id });
    expect((inApp.json.skills as { name: string }[]).map((s) => s.name)).not.toContain(MODULE);

    const configure = await callTool(mcp.client, 'configure_module', { app_id: app.app_id, module: MODULE, config: {} });
    expect(configure.isError).toBe(true);
    expect(configure.json.code).toBe('not_found');

    for (const path of ['/llms.txt', '/llms-full.txt']) {
      const res = await request.get(`${BASE_URL_WEB}${path}`);
      expect(res.status(), path).toBe(200);
      expect(await res.text(), path).not.toContain(MODULE);
    }

    const route = await hostRequest(previewHost(app.slug), `/__drobek/v1/${MODULE}/`);
    expect(route.status).toBe(404);
    const body = JSON.parse(route.body) as { error: string; details?: { available?: string[] } };
    expect(body.error).toBe('not_found');
    expect(body.details?.available ?? []).not.toContain(MODULE);

    await page.goto(`/workspaces/${app.workspace}/apps/${app.slug}/modules`);
    await expect(page.locator('[data-testid="module-row"][data-module="email"]')).toBeVisible();
    await expect(page.locator(`[data-testid="module-row"][data-module="${MODULE}"]`)).toHaveCount(0);
    expect(await page.content()).not.toContain(MODULE);
    const modulePage = await page.request.get(`${BASE_URL_WEB}/workspaces/${app.workspace}/apps/${app.slug}/modules/${MODULE}`);
    expect(modulePage.status()).toBe(404);
    await page.goto(`/workspaces/${app.workspace}/apps/${app.slug}/modules/email`);
    await expect(page.getByTestId('module-about')).toBeVisible();
    expect(await page.content()).not.toContain(MODULE);

    await page.goto(`/workspaces/${app.workspace}/modules`);
    await expect(page.locator('[data-testid="workspace-module"][data-module="email"]')).toBeVisible();
    await expect(page.locator(`[data-testid="workspace-module"][data-module="${MODULE}"]`)).toHaveCount(0);
    await expect(page.getByTestId('module-operator-only')).toHaveCount(0);
    expect(await page.content()).not.toContain(MODULE);
  } finally {
    await mcp.client.close();
  }
});

test('a super-admin sees the operator-only module on the workspace Modules page, marked as such @local', async ({ page, request }) => {
  skipUnlessLocal();
  await loginViaEmail(page, request, SUPER_ADMIN);
  const ws = await personalWorkspaceOf(SUPER_ADMIN);
  await page.goto(`/workspaces/${ws.slug}/modules`);
  const card = page.locator(`[data-testid="workspace-module"][data-module="${MODULE}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('module-operator-only')).toHaveText('operator-only');
  await expect(card.getByTestId('module-operator-only-note')).toContainText('Apps cannot use it, agents do not see it, and only super-admins see it here.');
  await expect(card.getByTestId('module-source')).toHaveText('dir');
  const email = page.locator('[data-testid="workspace-module"][data-module="email"]');
  await expect(email.getByTestId('module-operator-only')).toHaveCount(0);
  await email.getByTestId('module-technical').locator('summary').click();
  await expect(email.locator('[data-testid="slot-row"][data-slot="email.transport"]')).toContainText(MODULE);
});
