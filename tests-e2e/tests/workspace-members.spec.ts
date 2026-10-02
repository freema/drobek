import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import { addMembership, userIdByEmail, withDb, workspaceIdBySlug } from './helpers/seed';

/**
 * Managing a team's members against the local compose stack: the Members
 * tab lists and revokes pending invites, changes a role and removes a member,
 * who is out at once; a member leaves while the only workspace-admin cannot;
 * and the MCP member tools do the same — the removed member's agent gets
 * not_found and the edit lock it held is released. Every change is audited.
 */

function uniqueSlug(): string {
  return `e2e-mem-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

async function createTeam(page: Page, name: string, slug: string): Promise<void> {
  await page.goto('/workspaces');
  await page.getByLabel('Team name').fill(name);
  await page.getByLabel('Slug').fill(slug);
  await page.getByRole('button', { name: 'Create team' }).click();
  await page.waitForURL(new RegExp(`/workspaces/${slug}$`));
}

async function createInvite(page: Page, slug: string, role: string, email?: string): Promise<string> {
  await page.goto(`/workspaces/${slug}`);
  if (email) await page.getByLabel('Email (optional)').fill(email);
  await page.getByLabel('Role', { exact: true }).selectOption(role);
  await page.getByRole('button', { name: 'Create invite' }).click();
  const url = (await page.getByTestId('invite-link').textContent())?.trim();
  expect(url, 'the invite link').toBeTruthy();
  return url as string;
}

async function signedInPage(browser: Browser, request: import('@playwright/test').APIRequestContext, email: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginViaEmail(page, request, email);
  return page;
}

async function auditActions(slug: string): Promise<string[]> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT al.action FROM audit_log al JOIN workspaces w ON w.id = al.workspace_id
        WHERE w.slug = $1 AND al.action LIKE 'member.%' ORDER BY al.created_at`,
      [slug]
    );
    return res.rows.map((r) => r.action as string);
  });
}

test('members tab: pending invites listed and revoked, a role changed, a member removed and out at once @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  const admin = uniqueEmail('mem-admin');
  const invitee = uniqueEmail('mem-joiner');
  const slug = uniqueSlug();

  await loginViaEmail(page, request, admin);
  await createTeam(page, 'Member Crew', slug);
  await expect(page.getByTestId('invites-empty')).toBeVisible();

  const joinUrl = await createInvite(page, slug, 'editor', invitee);
  const linkOnly = await createInvite(page, slug, 'viewer');

  // Both invites are pending, newest first; the link-only one is revoked and its link stops working.
  await page.goto(`/workspaces/${slug}`);
  const rows = page.getByTestId('invite-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-role', 'viewer');
  await expect(rows.nth(1)).toContainText(invitee);
  page.once('dialog', (d) => void d.accept());
  await rows.first().getByTestId('invite-revoke').click();
  await expect(page.getByTestId('members-result')).toContainText('was revoked; its link no longer works');
  await expect(page.getByTestId('invite-row')).toHaveCount(1);
  expect((await page.request.get(linkOnly)).status()).toBe(404);

  // The invitee accepts the other one and is an editor.
  const joiner = await signedInPage(browser, request, invitee);
  try {
    await joiner.goto(joinUrl);
    await joiner.getByRole('button', { name: 'Accept invite' }).click();
    await joiner.waitForURL(new RegExp(`/workspaces/${slug}$`));
    await expect(joiner.getByTestId('my-role')).toHaveText('editor');
    await expect(joiner.getByTestId('pending-invites')).toHaveCount(0);
    await expect(joiner.getByTestId('member-remove')).toHaveCount(0);

    // The admin sees no pending invite any more, makes the invitee a viewer…
    await page.goto(`/workspaces/${slug}`);
    await expect(page.getByTestId('invites-empty')).toBeVisible();
    const row = page.getByTestId('member-row').filter({ hasText: invitee });
    await row.getByTestId('member-role-select').selectOption('viewer');
    await row.getByTestId('member-role-save').click();
    await expect(page.getByTestId('members-result')).toContainText(`${invitee} is now viewer`);
    await expect(page.getByTestId('member-row').filter({ hasText: invitee })).toHaveAttribute('data-role', 'viewer');

    // …and removes them: the next request of theirs is a 404.
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('member-row').filter({ hasText: invitee }).getByTestId('member-remove').click();
    await expect(page.getByTestId('members-result')).toContainText(`${invitee} was removed from the workspace`);
    await expect(page.getByTestId('member-row')).toHaveCount(1);

    const gone = await joiner.goto(`/workspaces/${slug}`);
    expect(gone?.status()).toBe(404);
    await joiner.goto('/workspaces');
    await expect(joiner.getByTestId('workspace-item').filter({ hasText: `/${slug}` })).toHaveCount(0);
  } finally {
    await joiner.context().close();
  }

  expect(await auditActions(slug)).toEqual(['member.invite', 'member.invite', 'member.invite_revoke', 'member.accept', 'member.role_change', 'member.remove']);
});

test('a member leaves the workspace; the only workspace-admin cannot, and a personal workspace has no Leave @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  const admin = uniqueEmail('mem-owner');
  const leaver = uniqueEmail('mem-leaver');
  const slug = uniqueSlug();

  await loginViaEmail(page, request, admin);
  await createTeam(page, 'Leave Crew', slug);
  await expect(page.getByTestId('leave-blocked')).toContainText('You are the only workspace-admin');
  await expect(page.getByTestId('leave-button')).toHaveCount(0);
  await expect(page.getByTestId('member-remove')).toHaveCount(0);

  const member = await signedInPage(browser, request, leaver);
  try {
    await addMembership(await userIdByEmail(leaver), await workspaceIdBySlug(slug), 'viewer');
    await member.goto(`/workspaces/${slug}`);
    await expect(member.getByTestId('my-role')).toHaveText('viewer');
    member.once('dialog', (d) => void d.accept());
    await member.getByTestId('leave-button').click();
    await member.waitForURL(/\/workspaces\?left=/);
    await expect(member.getByTestId('workspace-left')).toContainText(`You left the workspace /${slug}`);
    await expect(member.getByTestId('workspace-item').filter({ hasText: `/${slug}` })).toHaveCount(0);
    expect((await member.goto(`/workspaces/${slug}`))?.status()).toBe(404);

    // A personal workspace: one member, no Leave and no member controls.
    await member.goto('/workspaces');
    await member.getByTestId('workspace-item').filter({ hasText: 'personal' }).getByRole('link').click();
    await member.getByTestId('workspace-tab').filter({ hasText: 'Members' }).click();
    await expect(member.getByTestId('members-personal')).toBeVisible();
    await expect(member.getByTestId('leave-workspace')).toHaveCount(0);
  } finally {
    await member.context().close();
  }

  expect(await auditActions(slug)).toEqual(['member.leave']);
});

test('MCP: list_members, set_member_role and remove_member (user_confirmed) — the removed agent gets not_found, its lock is released @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  const slug = uniqueSlug();
  const admin = await mcpClient(page, request, { tag: 'mem-mcp-admin' });
  await createTeam(page, 'MCP Members', slug);

  const memberCtx = await browser.newContext();
  const memberPage = await memberCtx.newPage();
  const member = await mcpClient(memberPage, request, { tag: 'mem-mcp-editor' });
  try {
    await addMembership(await userIdByEmail(member.email), await workspaceIdBySlug(slug), 'editor');

    const listed = await callTool(admin.client, 'list_members', { workspace: slug });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.json).toMatchObject({ workspace: slug, kind: 'team', role: 'workspace-admin', can_manage: true });
    expect((listed.json.members as { email: string; role: string }[]).map((m) => [m.email, m.role])).toEqual([
      [admin.email, 'workspace-admin'],
      [member.email, 'editor'],
    ]);

    const created = await callTool(admin.client, 'create_app', { name: 'Member Lock', workspace: slug });
    expect(created.isError, created.text).toBe(false);
    const app = created.json as { app_id: string; slug: string };
    const write = (client: typeof admin.client) =>
      callTool(client, 'write_files', { app_id: app.app_id, files: [{ path: 'notes.txt', content: String(Date.now()) }], reasoning: 'e2e' });

    // The member's agent writes and holds the lease; the admin's agent is locked out.
    expect((await write(member.client)).isError).toBe(false);
    expect((await write(admin.client)).json).toMatchObject({ code: 'app_locked' });

    // Demoted to viewer: the lease is released at once.
    const demoted = await callTool(admin.client, 'set_member_role', { workspace: slug, email: member.email, role: 'viewer' });
    expect(demoted.json).toMatchObject({ from: 'editor', to: 'viewer', changed: true, released_locks: [app.slug] });
    expect((await write(member.client)).json).toMatchObject({ code: 'forbidden' });
    expect((await write(admin.client)).isError).toBe(false);

    // The only admin cannot be demoted.
    expect((await callTool(admin.client, 'set_member_role', { workspace: slug, email: admin.email, role: 'editor' })).json).toMatchObject({
      code: 'last_workspace_admin',
    });

    // Removal needs the user's yes; then the member's agent is out.
    const ask = await callTool(admin.client, 'remove_member', { workspace: slug, email: member.email });
    expect(ask.json).toMatchObject({ code: 'user_confirmation_required', role: 'viewer', leaving: false });
    const removed = await callTool(admin.client, 'remove_member', { workspace: slug, email: member.email, user_confirmed: true });
    expect(removed.isError, removed.text).toBe(false);
    expect(removed.json).toMatchObject({ removed: member.email, role: 'viewer', left: false });

    expect((await callTool(member.client, 'get_app', { app_id: app.app_id })).json).toMatchObject({ code: 'not_found' });
    expect((await callTool(member.client, 'list_members', { workspace: slug })).json).toMatchObject({ code: 'not_found' });
    const mine = (await callTool(member.client, 'list_apps', {})).json as { workspaces: { slug: string }[] };
    expect(mine.workspaces.map((w) => w.slug)).not.toContain(slug);
  } finally {
    await member.client.close();
    await memberCtx.close();
    await admin.client.close();
  }

  const actions = await withDb(async (c) => {
    const res = await c.query(
      `SELECT al.action, al.actor_kind FROM audit_log al JOIN workspaces w ON w.id = al.workspace_id
        WHERE w.slug = $1 AND al.action IN ('member.role_change', 'member.remove') ORDER BY al.created_at`,
      [slug]
    );
    return res.rows as { action: string; actor_kind: string }[];
  });
  expect(actions).toEqual([
    { action: 'member.role_change', actor_kind: 'agent' },
    { action: 'member.remove', actor_kind: 'agent' },
  ]);
});
