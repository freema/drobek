import { expect, test, type BrowserContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { loginViaEmail, mailpitMessagesFor, skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';
import { personalWorkspaceOf, withDb } from './helpers/seed';

/**
 * NSO-366: publish approval on the local stack.
 *
 *  - /admin/publishing is super-admin only (403 for anyone else); the
 *    super-admin approves and revokes a workspace there (audited);
 *  - list_apps / get_app carry `can_publish`; set_publish_approval is listed
 *    only for a super-admin and asks for user_confirmed before it acts;
 *  - with the stack started as PUBLISH_APPROVAL=approval (set
 *    E2E_PUBLISH_APPROVAL=approval, and E2E_OPERATOR_EMAIL when OPERATOR_EMAIL
 *    is set): a publish from an unapproved workspace answers
 *    publish_not_approved naming the contact, the operator gets one e-mail
 *    (a second blocked publish sends none), the dashboard shows the notice,
 *    and after approval the publish goes through. The dev stack runs `open`,
 *    so that part is skipped there.
 */

const SUPER_ADMIN = 'e2e-superadmin@drobek.test';
const APPROVAL = process.env.E2E_PUBLISH_APPROVAL === 'approval';
const OPERATOR = (process.env.E2E_OPERATOR_EMAIL ?? SUPER_ADMIN).toLowerCase();

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

test.describe.configure({ mode: 'serial' });

test.describe('publish approval (NSO-366) @local', () => {
  let owner: McpClient;
  let boss: McpClient | null = null;
  let admin: BrowserContext | null = null;

  test.afterAll(async () => {
    await owner?.client.close().catch(() => {});
    await boss?.client.close().catch(() => {});
    await admin?.close().catch(() => {});
  });

  test('a regular user: can_publish in list_apps, no set_publish_approval, /admin/publishing → 403', async ({ page, request }) => {
    skipUnlessLocal();
    owner = await mcpClient(page, request, { tag: 'approval-owner', scope: FULL_SCOPE });

    const listed = await callTool(owner.client, 'list_apps', {});
    const mine = (listed.json.workspaces as { slug: string; can_publish: boolean; publish_contact?: string }[]).find(
      (w) => w.slug === owner.workspace
    );
    expect(mine?.can_publish).toBe(!APPROVAL);
    if (APPROVAL) expect(mine?.publish_contact).toBe(OPERATOR);

    const tools = (await owner.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('publish');
    expect(tools).not.toContain('set_publish_approval');

    const res = await page.request.get(`${BASE_URL_WEB}/admin/publishing`, { maxRedirects: 0 });
    expect(res.status()).toBe(403);
    const post = await page.request.post(`${BASE_URL_WEB}/admin/publishing`, {
      headers: { Origin: BASE_URL_WEB },
      form: { intent: 'approve', workspaceId: 'anything' },
      maxRedirects: 0,
    });
    expect(post.status()).toBe(403);
  });

  test('approval mode: a blocked publish names the contact, mails the operator once and shows the notice', async ({ page, request }) => {
    skipUnlessLocal();
    test.skip(!APPROVAL, 'the stack runs PUBLISH_APPROVAL=open (set E2E_PUBLISH_APPROVAL=approval against a stack started with it)');
    await loginViaEmail(page, request, owner.email);

    const created = await callTool(owner.client, 'create_app', { name: 'Approval probe', workspace: owner.workspace, template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const app = created.json as unknown as Created;

    const blocked = await callTool(owner.client, 'publish', { app_id: app.app_id });
    expect(blocked.isError).toBe(true);
    expect(blocked.json).toMatchObject({ code: 'publish_not_approved', contact: OPERATOR });
    expect(String(blocked.json.message)).toContain(`needs approval from ${OPERATOR}`);
    expect(String(blocked.json.message)).toContain('An approval request was sent');

    const subject = `Publish approval requested: `;
    const ws = await personalWorkspaceOf(owner.email);
    await expect
      .poll(async () => (await mailpitMessagesFor(request, OPERATOR)).filter((m) => (m.Subject ?? '').startsWith(subject) && (m.Subject ?? '').includes(`(${ws.slug})`)).length)
      .toBe(1);

    const again = await callTool(owner.client, 'publish', { app_id: app.app_id });
    expect(again.json).toMatchObject({ code: 'publish_not_approved' });
    expect((await mailpitMessagesFor(request, OPERATOR)).filter((m) => (m.Subject ?? '').includes(`(${ws.slug})`)).length).toBe(1);

    const got = await callTool(owner.client, 'get_app', { app_id: app.app_id });
    expect(got.json).toMatchObject({ can_publish: false, publish_contact: OPERATOR });

    await page.goto(`/workspaces/${owner.workspace}/apps`);
    await expect(page.getByTestId('publish-approval-notice')).toBeVisible();
    await expect(page.getByTestId('publish-approval-text')).toContainText(`Publishing on this server needs approval from ${OPERATOR}`);
    await expect(page.getByTestId('publish-approval-notice')).toHaveAttribute('data-requested', '1');

    await page.goto(`/workspaces/${owner.workspace}/apps/${app.slug}`);
    await expect(page.locator('[data-blocked="approval"]').first()).toBeDisabled();

    expect((await workspaceAudit(ws.id)).map((a) => a.action)).toEqual(['workspace.publish_approval_request']);
  });

  test('a super-admin approves and revokes on /admin/publishing', async ({ browser, request }) => {
    skipUnlessLocal();
    admin = await browser.newContext();
    const ap = await admin.newPage();
    await loginViaEmail(ap, request, SUPER_ADMIN);
    const ws = await personalWorkspaceOf(owner.email);
    const before = (await workspaceAudit(ws.id)).length;

    await ap.goto('/admin/publishing?state=not_approved');
    if (!APPROVAL) await expect(ap.getByTestId('publishing-mode-open')).toBeVisible();
    const row = ap.locator(`[data-testid="publishing-workspace"][data-slug="${ws.slug}"]`);
    await expect(row).toHaveAttribute('data-approved', '0');
    if (APPROVAL) await expect(row.getByTestId('publishing-requested')).toContainText(owner.email);

    await row.getByTestId('publishing-approve').click();
    await expect(ap.getByTestId('publishing-result')).toHaveText(`${ws.slug} may publish now.`);
    await ap.goto('/admin/publishing?state=approved');
    const approvedRow = ap.locator(`[data-testid="publishing-workspace"][data-slug="${ws.slug}"]`);
    await expect(approvedRow).toHaveAttribute('data-approved', '1');
    await expect(approvedRow).toContainText(`by ${SUPER_ADMIN}`);

    await approvedRow.getByTestId('publishing-revoke').click();
    await expect(ap.getByTestId('publishing-result')).toContainText('can no longer publish');

    const audit = (await workspaceAudit(ws.id)).slice(before);
    expect(audit.map((a) => [a.action, a.actor_kind])).toEqual([
      ['workspace.publish_approve', 'user'],
      ['workspace.publish_revoke', 'user'],
    ]);
  });

  test('set_publish_approval over MCP: super-admin only, asks for user_confirmed, then approves', async ({ browser, request }) => {
    skipUnlessLocal();
    const ctx = await browser.newContext();
    try {
      const bp = await ctx.newPage();
      boss = await mcpClient(bp, request, { email: SUPER_ADMIN, scope: FULL_SCOPE });
      const tools = (await boss.client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('set_publish_approval');

      const ask = await callTool(boss.client, 'set_publish_approval', { workspace: owner.workspace, approved: true });
      expect(ask.isError).toBe(true);
      expect(ask.json).toMatchObject({ code: 'user_confirmation_required' });

      const ok = await callTool(boss.client, 'set_publish_approval', { workspace: owner.workspace, approved: true, user_confirmed: true });
      expect(ok.isError, ok.text).toBe(false);
      expect(ok.json).toMatchObject({ workspace: owner.workspace, approved: true, changed: true, mode: APPROVAL ? 'approval' : 'open' });
      expect(typeof ok.json.approved_at).toBe('string');

      const ws = await personalWorkspaceOf(owner.email);
      const audit = await workspaceAudit(ws.id);
      expect(audit.at(-1)).toMatchObject({ action: 'workspace.publish_approve', actor_kind: 'agent' });

      const listed = await callTool(owner.client, 'list_apps', {});
      const mine = (listed.json.workspaces as { slug: string; can_publish: boolean }[]).find((w) => w.slug === owner.workspace);
      expect(mine?.can_publish).toBe(true);

      if (APPROVAL) {
        const created = await callTool(owner.client, 'create_app', { name: 'Approved probe', workspace: owner.workspace, template: 'html' });
        expect(created.isError, created.text).toBe(false);
        const pub = await callTool(owner.client, 'publish', { app_id: (created.json as unknown as Created).app_id });
        expect(pub.isError, pub.text).toBe(false);
      }
    } finally {
      await ctx.close();
    }
  });
});
