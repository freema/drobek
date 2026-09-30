import { expect, test, type BrowserContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { loginViaEmail, mailpitMessagesFor, skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';
import { personalWorkspaceOf, withDb } from './helpers/seed';

/**
 * Who may publish, on the local stack.
 *
 *  - /admin/publishing is super-admin only (403 for anyone else);
 *  - list_apps / get_app carry `can_publish` + `publishing`;
 *    set_workspace_publishing is listed only for a super-admin and asks for
 *    user_confirmed before it acts;
 *  - blocking (in the default `open` stack too): the super-admin blocks the
 *    workspace on /admin/publishing, its admin is e-mailed, a publish answers
 *    publish_blocked naming the contact (no approval request), the dashboard
 *    shows the operator's notice with the Publish button disabled; unblocking
 *    e-mails again and the publish goes through; the same over MCP;
 *  - with the stack started as PUBLISH_APPROVAL=approval (set
 *    E2E_PUBLISH_APPROVAL=approval, and E2E_OPERATOR_EMAIL when OPERATOR_EMAIL
 *    is set): an unapproved publish answers publish_not_approved naming the
 *    contact, the operator gets one e-mail (a second refused publish sends
 *    none), and after approval the publish goes through. The dev stack runs
 *    `open`, so that part is skipped there.
 */

const SUPER_ADMIN = 'e2e-superadmin@drobek.test';
const APPROVAL = process.env.E2E_PUBLISH_APPROVAL === 'approval';
const OPERATOR = (process.env.E2E_OPERATOR_EMAIL ?? SUPER_ADMIN).toLowerCase();
const BLOCKED_MESSAGE = `Publishing from this workspace was turned off by the operator of this server (${OPERATOR}). Previews, versions and everything else keep working; live apps keep serving unless taken down.`;

interface Created {
  app_id: string;
  slug: string;
}

async function workspaceAudit(workspaceId: string): Promise<{ action: string; actor_kind: string }[]> {
  return withDb(async (c) =>
    (
      await c.query(
        `SELECT action, actor_kind FROM audit_log
          WHERE workspace_id = $1 AND action LIKE 'workspace.publish_%'
          ORDER BY created_at`,
        [workspaceId]
      )
    ).rows
  );
}

async function requestedAt(workspaceId: string): Promise<Date | null> {
  return withDb(async (c) => (await c.query('SELECT publish_approval_requested_at AS at FROM workspaces WHERE id = $1', [workspaceId])).rows[0].at);
}

test.describe.configure({ mode: 'serial' });

test.describe('publish approval and blocking @local', () => {
  let owner: McpClient;
  let boss: McpClient | null = null;
  let admin: BrowserContext | null = null;
  let probe: Created;

  test.afterAll(async () => {
    await owner?.client.close().catch(() => {});
    await boss?.client.close().catch(() => {});
    await admin?.close().catch(() => {});
  });

  test('a regular user: can_publish + publishing in list_apps, no set_workspace_publishing, /admin/publishing → 403', async ({ page, request }) => {
    skipUnlessLocal();
    owner = await mcpClient(page, request, { tag: 'approval-owner', scope: FULL_SCOPE });

    const listed = await callTool(owner.client, 'list_apps', {});
    const mine = (listed.json.workspaces as { slug: string; can_publish: boolean; publish_contact?: string; publishing: string }[]).find(
      (w) => w.slug === owner.workspace
    );
    expect(mine?.can_publish).toBe(!APPROVAL);
    expect(mine?.publishing).toBe('default');
    if (APPROVAL) expect(mine?.publish_contact).toBe(OPERATOR);

    const tools = (await owner.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('publish');
    expect(tools).not.toContain('set_workspace_publishing');

    const res = await page.request.get(`${BASE_URL_WEB}/admin/publishing`, { maxRedirects: 0 });
    expect(res.status()).toBe(403);
    const post = await page.request.post(`${BASE_URL_WEB}/admin/publishing`, {
      headers: { Origin: BASE_URL_WEB },
      form: { intent: 'block', workspaceId: 'anything' },
      maxRedirects: 0,
    });
    expect(post.status()).toBe(403);

    const created = await callTool(owner.client, 'create_app', { name: 'Approval probe', workspace: owner.workspace, template: 'html' });
    expect(created.isError, created.text).toBe(false);
    probe = created.json as unknown as Created;
  });

  test('approval mode: an unapproved publish names the contact, mails the operator once and shows the notice', async ({ page, request }) => {
    skipUnlessLocal();
    test.skip(!APPROVAL, 'the stack runs PUBLISH_APPROVAL=open (set E2E_PUBLISH_APPROVAL=approval against a stack started with it)');
    await loginViaEmail(page, request, owner.email);

    const blocked = await callTool(owner.client, 'publish', { app_id: probe.app_id });
    expect(blocked.isError).toBe(true);
    expect(blocked.json).toMatchObject({ code: 'publish_not_approved', contact: OPERATOR });
    expect(String(blocked.json.message)).toContain(`needs approval from ${OPERATOR}`);
    expect(String(blocked.json.message)).toContain('An approval request was sent');

    const subject = `Publish approval requested: `;
    const ws = await personalWorkspaceOf(owner.email);
    await expect
      .poll(async () => (await mailpitMessagesFor(request, OPERATOR)).filter((m) => (m.Subject ?? '').startsWith(subject) && (m.Subject ?? '').includes(`(${ws.slug})`)).length)
      .toBe(1);

    const again = await callTool(owner.client, 'publish', { app_id: probe.app_id });
    expect(again.json).toMatchObject({ code: 'publish_not_approved' });
    expect((await mailpitMessagesFor(request, OPERATOR)).filter((m) => (m.Subject ?? '').includes(`(${ws.slug})`)).length).toBe(1);

    const got = await callTool(owner.client, 'get_app', { app_id: probe.app_id });
    expect(got.json).toMatchObject({ can_publish: false, publish_contact: OPERATOR, publishing: 'default' });

    await page.goto(`/workspaces/${owner.workspace}/apps`);
    await expect(page.getByTestId('publish-approval-notice')).toBeVisible();
    await expect(page.getByTestId('publish-approval-notice')).toHaveAttribute('data-kind', 'approval');
    await expect(page.getByTestId('publish-approval-text')).toContainText(`Publishing on this server needs approval from ${OPERATOR}`);
    await expect(page.getByTestId('publish-approval-notice')).toHaveAttribute('data-requested', '1');

    await page.goto(`/workspaces/${owner.workspace}/apps/${probe.slug}`);
    await expect(page.locator('[data-blocked="approval"]').first()).toBeDisabled();

    expect((await workspaceAudit(ws.id)).map((a) => a.action)).toEqual(['workspace.publish_approval_request']);
  });

  test('a super-admin blocks on /admin/publishing: publish_blocked, the owner is told; unblock lets it publish again', async ({ browser, page, request }) => {
    skipUnlessLocal();
    admin = await browser.newContext();
    const ap = await admin.newPage();
    await loginViaEmail(ap, request, SUPER_ADMIN);
    const ws = await personalWorkspaceOf(owner.email);
    const before = (await workspaceAudit(ws.id)).length;

    await ap.goto(`/admin/publishing?workspace=${ws.slug}`);
    await expect(ap.getByTestId(APPROVAL ? 'publishing-mode-approval' : 'publishing-mode-open')).toBeVisible();
    const row = ap.locator(`[data-testid="publishing-workspace"][data-slug="${ws.slug}"]`);
    await expect(row).toHaveAttribute('data-publishing', 'default');
    await row.getByTestId('publishing-block').click();
    // Block opens a confirm panel naming the workspace; only its button blocks.
    await expect(ap.getByTestId('block-confirm')).toHaveAttribute('data-slug', ws.slug);
    await ap.getByTestId('block-confirm-submit').click();
    await expect(ap.getByTestId('publishing-result')).toHaveText(
      `${ws.slug} can no longer publish. Its live apps keep serving; its editors and admins were e-mailed.`
    );
    await ap.goto(`/admin/publishing?state=blocked`);
    const blockedRow = ap.locator(`[data-testid="publishing-workspace"][data-slug="${ws.slug}"]`);
    await expect(blockedRow).toHaveAttribute('data-publishing', 'blocked');
    await expect(blockedRow.getByTestId('publishing-blocked')).toContainText(`by ${SUPER_ADMIN}`);

    await expect
      .poll(async () => (await mailpitMessagesFor(request, owner.email)).filter((m) => (m.Subject ?? '').startsWith('Publishing is turned off for your workspace')).length)
      .toBe(1);

    const refused = await callTool(owner.client, 'publish', { app_id: probe.app_id });
    expect(refused.isError).toBe(true);
    expect(refused.json).toMatchObject({ code: 'publish_blocked', contact: OPERATOR, message: BLOCKED_MESSAGE });
    expect(String(refused.json.hint)).toMatch(/Do not retry/);
    expect(await requestedAt(ws.id)).toBeNull();
    const listed = await callTool(owner.client, 'list_apps', {});
    expect((listed.json.workspaces as { slug: string }[]).find((w) => w.slug === owner.workspace)).toMatchObject({
      can_publish: false,
      publish_contact: OPERATOR,
      publishing: 'blocked',
    });

    await loginViaEmail(page, request, owner.email);
    await page.goto(`/workspaces/${owner.workspace}/apps`);
    await expect(page.getByTestId('publish-approval-notice')).toHaveAttribute('data-kind', 'blocked');
    await expect(page.getByTestId('publish-approval-text')).toHaveText(`Publishing from this workspace was turned off by the operator (${OPERATOR}).`);
    await expect(page.getByTestId('request-approval-button')).toHaveCount(0);
    await page.goto(`/workspaces/${owner.workspace}/apps/${probe.slug}`);
    await expect(page.locator('[data-blocked="blocked"]').first()).toBeDisabled();

    await ap.goto(`/admin/publishing?workspace=${ws.slug}`);
    await ap.locator(`[data-testid="publishing-workspace"][data-slug="${ws.slug}"]`).getByTestId('publishing-unblock').click();
    await expect(ap.getByTestId('publishing-result')).toContainText(`${ws.slug} is unblocked`);
    await expect
      .poll(async () => (await mailpitMessagesFor(request, owner.email)).filter((m) => (m.Subject ?? '').startsWith('Publishing is turned back on for your workspace')).length)
      .toBe(1);

    if (!APPROVAL) {
      const ok = await callTool(owner.client, 'publish', { app_id: probe.app_id });
      expect(ok.isError, ok.text).toBe(false);
    }

    const audit = (await workspaceAudit(ws.id)).slice(before);
    expect(audit.map((a) => [a.action, a.actor_kind])).toEqual([
      ['workspace.publish_block', 'user'],
      ['workspace.publish_unblock', 'user'],
    ]);
  });

  test('a super-admin approves and revokes on /admin/publishing', async () => {
    skipUnlessLocal();
    const ap = await admin!.newPage();
    const ws = await personalWorkspaceOf(owner.email);
    const before = (await workspaceAudit(ws.id)).length;

    await ap.goto(`/admin/publishing?workspace=${ws.slug}`);
    const row = ap.locator(`[data-testid="publishing-workspace"][data-slug="${ws.slug}"]`);
    await expect(row).toHaveAttribute('data-approved', '0');

    await row.getByTestId('publishing-approve').click();
    await expect(ap.getByTestId('publishing-result')).toHaveText(`${ws.slug} may publish now.`);
    await ap.goto('/admin/publishing?state=allowed');
    const approvedRow = ap.locator(`[data-testid="publishing-workspace"][data-slug="${ws.slug}"]`);
    await expect(approvedRow).toHaveAttribute('data-approved', '1');
    await expect(approvedRow).toContainText(`by ${SUPER_ADMIN}`);

    if (APPROVAL) {
      const pub = await callTool(owner.client, 'publish', { app_id: probe.app_id });
      expect(pub.isError, pub.text).toBe(false);
    }

    await approvedRow.getByTestId('publishing-revoke').click();
    await expect(ap.getByTestId('publishing-result')).toContainText(APPROVAL ? 'can no longer publish' : 'follows the server default again');

    const audit = (await workspaceAudit(ws.id)).slice(before);
    expect(audit.map((a) => [a.action, a.actor_kind])).toEqual([
      ['workspace.publish_approve', 'user'],
      ['workspace.publish_revoke', 'user'],
    ]);
  });

  test('set_workspace_publishing over MCP: super-admin only, asks for user_confirmed, then blocks, resets and allows', async ({ browser, request }) => {
    skipUnlessLocal();
    const ctx = await browser.newContext();
    try {
      const bp = await ctx.newPage();
      boss = await mcpClient(bp, request, { email: SUPER_ADMIN, scope: FULL_SCOPE });
      const tools = (await boss.client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('set_workspace_publishing');
      expect(tools).not.toContain('set_publish_approval'); // doc-lint: allow — the v0.3.0 name, asserted gone

      const ask = await callTool(boss.client, 'set_workspace_publishing', { workspace: owner.workspace, publishing: 'blocked' });
      expect(ask.isError).toBe(true);
      expect(ask.json).toMatchObject({ code: 'user_confirmation_required' });

      const blocked = await callTool(boss.client, 'set_workspace_publishing', { workspace: owner.workspace, publishing: 'blocked', user_confirmed: true });
      expect(blocked.isError, blocked.text).toBe(false);
      expect(blocked.json).toEqual({ workspace: owner.workspace, publishing: 'blocked', mode: APPROVAL ? 'approval' : 'open', can_publish_now: false, changed: true });
      const refused = await callTool(owner.client, 'publish', { app_id: probe.app_id });
      expect(refused.json).toMatchObject({ code: 'publish_blocked', contact: OPERATOR });

      const reset = await callTool(boss.client, 'set_workspace_publishing', { workspace: owner.workspace, publishing: 'default', user_confirmed: true });
      expect(reset.json).toMatchObject({ publishing: 'default', can_publish_now: !APPROVAL, changed: true });

      const ok = await callTool(boss.client, 'set_workspace_publishing', { workspace: owner.workspace, publishing: 'allowed', user_confirmed: true });
      expect(ok.isError, ok.text).toBe(false);
      expect(ok.json).toEqual({ workspace: owner.workspace, publishing: 'allowed', mode: APPROVAL ? 'approval' : 'open', can_publish_now: true, changed: true });

      const ws = await personalWorkspaceOf(owner.email);
      expect((await workspaceAudit(ws.id)).slice(-3)).toEqual([
        { action: 'workspace.publish_block', actor_kind: 'agent' },
        { action: 'workspace.publish_unblock', actor_kind: 'agent' },
        { action: 'workspace.publish_approve', actor_kind: 'agent' },
      ]);

      const listed = await callTool(owner.client, 'list_apps', {});
      expect((listed.json.workspaces as { slug: string }[]).find((w) => w.slug === owner.workspace)).toMatchObject({
        can_publish: true,
        publishing: 'allowed',
      });
      const pub = await callTool(owner.client, 'publish', { app_id: probe.app_id });
      expect(pub.isError, pub.text).toBe(false);
    } finally {
      await ctx.close();
    }
  });
});
