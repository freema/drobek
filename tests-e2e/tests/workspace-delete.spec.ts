import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { hostRequest, previewHost } from './helpers/apps-host';
import { loginViaEmail, mailpitMessagesFor, pollLoginCode, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { callTool, mcpClient, rawInitialize } from './helpers/mcp';
import { addMembership, userIdByEmail, withDb, workspaceIdBySlug } from './helpers/seed';

/**
 * Deleting a team workspace and deleting an account against the local compose
 * stack:
 *   (1) a workspace admin deletes a team workspace on its delete page after
 *       typing its slug — the app's address stops answering, a member gets
 *       404, the rows are gone and the audit rows stay;
 *   (2) the same over MCP with `delete_workspace`, which asks for the user's
 *       yes first;
 *   (3) a user deletes their account on /me/delete: refused while they are
 *       the only admin of a team another member uses, then, after the role
 *       is handed over and a fresh e-mailed code, the account goes — every
 *       session, the API key and the OAuth connection stop working, the team
 *       stays with the user's versions and a `member.leave` row.
 */

function uniqueSlug(): string {
  return `e2e-del-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

async function createTeam(page: Page, name: string, slug: string): Promise<void> {
  await page.goto('/workspaces');
  await page.getByLabel('Team name').fill(name);
  await page.getByLabel('Slug').fill(slug);
  await page.getByRole('button', { name: 'Create team' }).click();
  await page.waitForURL(new RegExp(`/workspaces/${slug}$`));
}

async function signedInPage(browser: Browser, request: APIRequestContext, email: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginViaEmail(page, request, email);
  return page;
}

async function workspaceRows(slug: string): Promise<number> {
  return withDb(async (c) => (await c.query('SELECT 1 FROM workspaces WHERE slug = $1', [slug])).rowCount ?? 0);
}

async function workspaceDeleteAudit(slug: string): Promise<{ actor_kind: string; meta: Record<string, unknown> }[]> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT actor_kind, meta FROM audit_log WHERE action = 'workspace.delete' AND target = $1 ORDER BY created_at, id`,
      [slug]
    );
    return res.rows as { actor_kind: string; meta: Record<string, unknown> }[];
  });
}

test('a workspace admin deletes a team workspace after typing its slug; its app and its members are out at once @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  const slug = uniqueSlug();
  const admin = await mcpClient(page, request, { tag: 'del-ws-admin' });
  const memberEmail = uniqueEmail('del-ws-member');
  const member = await signedInPage(browser, request, memberEmail);
  try {
    await createTeam(page, 'Delete Crew', slug);
    await addMembership(await userIdByEmail(memberEmail), await workspaceIdBySlug(slug), 'editor');
    const created = await callTool(admin.client, 'create_app', { name: 'Doomed', workspace: slug });
    expect(created.isError, created.text).toBe(false);
    const app = created.json as { app_id: string; slug: string };
    await expect.poll(async () => (await hostRequest(previewHost(app.slug))).status).toBe(200);

    // An editor sees no delete section and is refused on the page itself.
    await member.goto(`/workspaces/${slug}`);
    await expect(member.getByTestId('delete-workspace')).toHaveCount(0);
    expect((await member.goto(`/workspaces/${slug}/delete`))?.status()).toBe(403);

    await page.goto(`/workspaces/${slug}`);
    await page.getByTestId('delete-workspace-link').click();
    await page.waitForURL(new RegExp(`/workspaces/${slug}/delete$`));
    const summary = page.getByTestId('delete-workspace-summary');
    await expect(summary).toContainText('deletes 1 app');
    await expect(summary).toContainText('ends the access of 2 members');

    // A wrong slug deletes nothing.
    await page.getByTestId('delete-workspace-confirm').fill('not-the-slug');
    await page.getByTestId('delete-workspace-button').click();
    await expect(page.getByTestId('delete-workspace-error')).toContainText('Nothing was deleted');
    expect(await workspaceRows(slug)).toBe(1);

    await page.getByTestId('delete-workspace-confirm').fill(slug);
    await page.getByTestId('delete-workspace-button').click();
    await page.waitForURL(new RegExp(`/workspaces\\?deleted=${slug}$`));
    await expect(page.getByTestId('workspace-deleted')).toContainText(slug);

    expect(await workspaceRows(slug)).toBe(0);
    const appRows = await withDb(async (c) => (await c.query('SELECT 1 FROM apps WHERE id = $1', [app.app_id])).rowCount);
    expect(appRows).toBe(0);
    await expect.poll(async () => (await hostRequest(previewHost(app.slug))).status).toBe(404);
    expect((await member.goto(`/workspaces/${slug}`))?.status()).toBe(404);
    expect((await callTool(admin.client, 'get_app', { app_id: app.app_id })).json).toMatchObject({ code: 'not_found' });

    // One row in the deleted workspace's own trail, one in the admin's personal workspace.
    const audit = await workspaceDeleteAudit(slug);
    expect(audit).toHaveLength(2);
    for (const row of audit) expect(row).toMatchObject({ actor_kind: 'user', meta: { apps: 1, members: 2 } });
  } finally {
    await member.context().close();
    await admin.client.close();
  }
});

test('MCP: delete_workspace asks for the user’s yes, then deletes the team workspace with its apps @local', async ({ page, request }) => {
  skipUnlessLocal();
  const slug = uniqueSlug();
  const admin = await mcpClient(page, request, { tag: 'del-ws-mcp' });
  try {
    await createTeam(page, 'Delete by agent', slug);
    const created = await callTool(admin.client, 'create_app', { name: 'Agent Doomed', workspace: slug });
    expect(created.isError, created.text).toBe(false);
    const app = created.json as { app_id: string; slug: string };

    const ask = await callTool(admin.client, 'delete_workspace', { workspace: slug });
    expect(ask.isError).toBe(true);
    expect(ask.json).toMatchObject({ code: 'user_confirmation_required', workspace: slug, apps: 1, published: 0, members: 1 });
    expect(await workspaceRows(slug)).toBe(1);

    const personal = await callTool(admin.client, 'delete_workspace', { workspace: admin.workspace, user_confirmed: true });
    expect(personal.json).toMatchObject({ code: 'personal_workspace' });

    const deleted = await callTool(admin.client, 'delete_workspace', { workspace: slug, user_confirmed: true });
    expect(deleted.isError, deleted.text).toBe(false);
    expect(deleted.json).toMatchObject({ deleted: slug, apps: [app.slug], members: 1 });

    expect(await workspaceRows(slug)).toBe(0);
    expect((await callTool(admin.client, 'get_app', { app_id: app.app_id })).json).toMatchObject({ code: 'not_found' });
    const listed = (await callTool(admin.client, 'list_apps', {})).json as { workspaces: { slug: string }[] };
    expect(listed.workspaces.map((w) => w.slug)).not.toContain(slug);
    expect((await callTool(admin.client, 'delete_workspace', { workspace: slug, user_confirmed: true })).json).toMatchObject({
      code: 'not_found',
    });
    const audit = await workspaceDeleteAudit(slug);
    expect(audit.map((r) => r.actor_kind)).toEqual(['agent', 'agent']);
  } finally {
    await admin.client.close();
  }
});

test('account deletion: refused while the user is a team’s only admin, then with a fresh code every session, key and connection ends @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  const slug = uniqueSlug();
  const owner = await mcpClient(page, request, { tag: 'del-acct' });
  const ownerId = await userIdByEmail(owner.email);
  const colleagueEmail = uniqueEmail('del-acct-colleague');
  await (await signedInPage(browser, request, colleagueEmail)).context().close();
  const second = await signedInPage(browser, request, owner.email);
  try {
    await createTeam(page, 'Kept Team', slug);
    const teamId = await workspaceIdBySlug(slug);
    await addMembership(await userIdByEmail(colleagueEmail), teamId, 'editor');
    const created = await callTool(owner.client, 'create_app', { name: 'Kept App', workspace: slug });
    expect(created.isError, created.text).toBe(false);
    const keptApp = created.json as { app_id: string };
    const mine = await callTool(owner.client, 'create_app', { name: 'Personal App', workspace: owner.workspace });
    expect(mine.isError, mine.text).toBe(false);
    const personalApp = mine.json as { app_id: string };

    // An API key of the account.
    await page.goto('/me/api-keys');
    await page.getByTestId('api-key-name').fill('e2e delete key');
    await page.getByTestId('api-key-create').click();
    const key = ((await page.getByTestId('api-key-value').textContent()) ?? '').trim();
    expect(key).toMatch(/^drk_/);
    expect((await rawInitialize(request, { Authorization: `Bearer ${key}` })).status()).toBe(200);

    // The only workspace-admin of a team another member uses: refused, with the way out.
    await page.goto('/me');
    await page.getByTestId('me-delete-account-link').click();
    await page.waitForURL(/\/me\/delete$/);
    const blocked = page.getByTestId('account-delete-blocked');
    await expect(blocked).toContainText('Your account cannot be deleted yet');
    await expect(blocked.locator(`[data-slug="${slug}"]`)).toContainText('make another member a workspace-admin');
    await expect(page.getByTestId('account-delete-form')).toHaveCount(0);
    await expect(page.getByTestId('account-delete-deletes').locator(`[data-slug="${owner.workspace}"]`)).toBeVisible();

    // Hand the role over; the team is now one the user leaves.
    const handed = await callTool(owner.client, 'set_member_role', { workspace: slug, email: colleagueEmail, role: 'workspace-admin' });
    expect(handed.isError, handed.text).toBe(false);
    await page.reload();
    await expect(page.getByTestId('account-delete-blocked')).toHaveCount(0);
    await expect(page.getByTestId('account-delete-leaves').locator(`[data-slug="${slug}"]`)).toBeVisible();

    const seen = new Set((await mailpitMessagesFor(request, owner.email)).map((m) => m.ID));
    await page.getByTestId('account-delete-send-code').click();
    await expect(page.getByTestId('account-delete-code-sent')).toBeVisible();

    // A wrong code deletes nothing.
    await page.getByTestId('account-delete-code').fill('000000');
    await page.getByTestId('account-delete-button').click();
    await expect(page.getByTestId('account-delete-error')).toContainText('That code is not valid');
    expect(await withDb(async (c) => (await c.query('SELECT 1 FROM users WHERE email = $1', [owner.email])).rowCount)).toBe(1);

    const code = await pollLoginCode(request, owner.email, 30_000, seen);
    await page.getByTestId('account-delete-code').fill(code);
    await page.getByTestId('account-delete-button').click();
    await page.waitForURL(/\/login\?deleted=account$/);
    await expect(page.getByTestId('login-account-deleted')).toBeVisible();

    // Every session, the API key and the OAuth connection are gone.
    await second.goto('/me');
    await expect(second).toHaveURL(/\/login/);
    expect((await rawInitialize(request, { Authorization: `Bearer ${key}` })).status()).toBe(401);
    expect((await rawInitialize(request, { Authorization: `Bearer ${owner.token}` })).status()).toBe(401);

    const after = await withDb(async (c) => ({
      user: (await c.query('SELECT 1 FROM users WHERE email = $1', [owner.email])).rowCount,
      personal: (await c.query('SELECT 1 FROM workspaces WHERE slug = $1', [owner.workspace])).rowCount,
      personalApp: (await c.query('SELECT 1 FROM apps WHERE id = $1', [personalApp.app_id])).rowCount,
      team: (await c.query('SELECT 1 FROM workspaces WHERE id = $1', [teamId])).rowCount,
      keptVersions: (
        await c.query('SELECT created_by_user_id FROM app_versions WHERE app_id = $1', [keptApp.app_id])
      ).rows.map((r) => r.created_by_user_id as string | null),
      leave: (
        await c.query(`SELECT actor_user_id, meta FROM audit_log WHERE workspace_id = $1 AND action = 'member.leave'`, [teamId])
      ).rows as { actor_user_id: string | null; meta: Record<string, unknown> }[],
      account: (await c.query(`SELECT actor_kind FROM audit_log WHERE action = 'account.delete' AND target = $1`, [ownerId])).rows,
    }));
    expect(after).toMatchObject({ user: 0, personal: 0, personalApp: 0, team: 1, account: [{ actor_kind: 'user' }] });
    expect(after.keptVersions.length).toBeGreaterThan(0);
    expect(after.keptVersions.every((v) => v === null)).toBe(true);
    expect(after.leave).toEqual([{ actor_user_id: null, meta: { role: 'workspace-admin', reason: 'account_deleted' } }]);
  } finally {
    await second.context().close();
    await owner.client.close();
  }
});
