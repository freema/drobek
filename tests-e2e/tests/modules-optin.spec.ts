import { expect, test, type BrowserContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost } from './helpers/apps-host';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';
import { addMembership, personalWorkspaceOf, userIdByEmail, withDb } from './helpers/seed';

/**
 * NSO-346: opt-in modules per workspace on the local stack.
 *
 *  - the Workspace → Modules page (NSO-347, readable by every member): a
 *    workspace admin and an editor see it (tab + list, read-only, no
 *    switch); the switch POST → 403 for both;
 *  - with an opt-in module on the server (`availability: 'opt-in'` — the
 *    dev stack gets one with the EXT-09 example module; until then the flow
 *    is skipped): off for a fresh workspace → its route answers
 *    `404 module_not_enabled`, configure_module refuses, get_app says
 *    `enabled: false` and leaves it out of `skills`, skill_info(app_id) says
 *    `enabled_for_workspace: false`; a super-admin enables it on the page
 *    (audit `module.workspace_enable`) → all of it flips; Disable → back.
 *
 * The super-admin is `e2e-superadmin@drobek.test` (see abuse.spec.ts).
 */

const SUPER_ADMIN = 'e2e-superadmin@drobek.test';

interface Created {
  app_id: string;
  slug: string;
}

interface SkillItem {
  name: string;
  use_when: string;
  availability?: string;
  enabled_for_workspace?: boolean;
}

async function workspaceAudit(workspaceId: string): Promise<{ action: string; target: string; actor_kind: string; meta: Record<string, unknown> | null }[]> {
  return withDb(async (c) =>
    (
      await c.query(
        `SELECT action, target, actor_kind, meta FROM audit_log
          WHERE workspace_id = $1 AND action LIKE 'module.workspace_%'
          ORDER BY created_at`,
        [workspaceId]
      )
    ).rows
  );
}

test.describe.configure({ mode: 'serial' });

test.describe('opt-in modules per workspace (NSO-346) @local', () => {
  let owner: McpClient;
  let admin: BrowserContext | null = null;

  test.afterAll(async () => {
    await owner?.client.close().catch(() => {});
    await admin?.close().catch(() => {});
  });

  test('Workspace → Modules: a workspace admin and an editor see it read-only; the switch answers both 403', async ({ page, request, browser }) => {
    skipUnlessLocal();
    owner = await mcpClient(page, request, { tag: 'optin-owner', scope: FULL_SCOPE });
    const modulesUrl = `/workspaces/${owner.workspace}/modules`;
    const toggle = { intent: 'workspace-module', module: 'anything', enabled: '1' };

    await page.goto(`/workspaces/${owner.workspace}/apps`);
    await expect(page.locator('[data-testid="workspace-tab"][data-tab="modules"]')).toBeVisible();
    await page.goto(modulesUrl);
    await expect(page.getByTestId('modules-intro')).toBeVisible();
    await expect(page.getByTestId('workspace-module-toggle')).toHaveCount(0);

    const res = await page.request.post(`${BASE_URL_WEB}${modulesUrl}`, { headers: { Origin: BASE_URL_WEB }, form: toggle, maxRedirects: 0 });
    expect(res.status()).toBe(403);

    const editorEmail = uniqueEmail('optin-editor');
    const ctx = await browser.newContext();
    try {
      const ep = await ctx.newPage();
      await loginViaEmail(ep, request, editorEmail);
      const ws = await personalWorkspaceOf(owner.email);
      await addMembership(await userIdByEmail(editorEmail), ws.id, 'editor');
      await ep.goto(modulesUrl);
      await expect(ep.getByTestId('modules-intro')).toBeVisible();
      await expect(ep.getByTestId('workspace-module-toggle')).toHaveCount(0);
      const r = await ep.request.post(`${BASE_URL_WEB}${modulesUrl}`, { headers: { Origin: BASE_URL_WEB }, form: toggle, maxRedirects: 0 });
      expect(r.status()).toBe(403);
    } finally {
      await ctx.close();
    }
  });

  test('an opt-in module: off → module_not_enabled everywhere; a super-admin enables it → on; disable → off', async ({
    page,
    browser,
    request,
  }) => {
    skipUnlessLocal();
    await loginViaEmail(page, request, owner.email);
    const listed = await callTool(owner.client, 'skill_info', {});
    const optIn = (listed.json.skills as SkillItem[]).find((s) => s.availability === 'opt-in');
    test.skip(!optIn, 'the stack runs no opt-in module (the EXT-09 example module adds one)');
    const name = optIn!.name;

    const created = await callTool(owner.client, 'create_app', { name: 'Opt-in probe', workspace: owner.workspace, template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const app = created.json as unknown as Created;
    expect((created.json.skills as SkillItem[]).map((s) => s.name)).not.toContain(name);

    // ── off ──
    let got = await callTool(owner.client, 'get_app', { app_id: app.app_id });
    expect((got.json.modules as Record<string, { enabled: boolean }>)[name].enabled).toBe(false);
    expect((got.json.skills as SkillItem[]).map((s) => s.name)).not.toContain(name);
    const inApp = await callTool(owner.client, 'skill_info', { app_id: app.app_id });
    expect((inApp.json.skills as SkillItem[]).find((s) => s.name === name)).toMatchObject({ availability: 'opt-in', enabled_for_workspace: false });
    const refused = await callTool(owner.client, 'configure_module', { app_id: app.app_id, module: name, config: {} });
    expect(refused.isError).toBe(true);
    expect(refused.json).toMatchObject({ code: 'module_not_enabled', module: name, hint: `skill_info('${name}')` });
    const route = await hostRequest(previewHost(app.slug), `/__drobek/v1/${name}/`);
    expect(route.status).toBe(404);
    expect(JSON.parse(route.body)).toMatchObject({ error: 'module_not_enabled', details: { module: name }, hint: `skill_info('${name}')` });

    await page.goto(`/workspaces/${owner.workspace}/apps/${app.slug}/modules/${name}`);
    await expect(page.getByTestId('module-not-enabled')).toBeVisible();

    // ── a super-admin enables it ──
    admin = await browser.newContext();
    const ap = await admin.newPage();
    await loginViaEmail(ap, request, SUPER_ADMIN);
    await ap.goto(`/workspaces/${owner.workspace}/modules`);
    const row = ap.locator(`[data-testid="workspace-module-row"][data-module="${name}"]`);
    await expect(row).toHaveAttribute('data-enabled', '0');
    await row.getByTestId('workspace-module-toggle').click();
    await expect(row).toHaveAttribute('data-enabled', '1');
    await expect(row).toHaveAttribute('data-source', 'dashboard');
    await expect(row.getByTestId('workspace-module-source')).toContainText(SUPER_ADMIN);

    got = await callTool(owner.client, 'get_app', { app_id: app.app_id });
    expect((got.json.modules as Record<string, { enabled: boolean }>)[name].enabled).toBe(true);
    expect((got.json.skills as SkillItem[]).map((s) => s.name)).toContain(name);
    const on = await hostRequest(previewHost(app.slug), `/__drobek/v1/${name}/`);
    expect(on.body).not.toContain('module_not_enabled');

    // ── and disables it again ──
    await row.getByTestId('workspace-module-toggle').click();
    await expect(row).toHaveAttribute('data-enabled', '0');
    const off = await hostRequest(previewHost(app.slug), `/__drobek/v1/${name}/`);
    expect(JSON.parse(off.body)).toMatchObject({ error: 'module_not_enabled' });

    const ws = await personalWorkspaceOf(owner.email);
    const audit = await workspaceAudit(ws.id);
    expect(audit.map((a) => [a.action, a.target, a.actor_kind])).toEqual([
      ['module.workspace_enable', name, 'user'],
      ['module.workspace_disable', name, 'user'],
    ]);
    expect(audit[0].meta).toMatchObject({ module: name });
  });
});
