import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { hostRequest, prodHost, previewHost } from './helpers/apps-host';
import { MAILPIT_URL, loginViaEmail, mailpitMessagesFor, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * Workspaces and the operator's tools over MCP on the local stack.
 *
 *  - create_workspace: a team workspace with the caller as workspace-admin
 *    (list_apps shows it; the slug is then slug_taken);
 *  - invite_member: user_confirmation_required first, then the invite e-mail
 *    reaches Mailpit, the answer never carries the link, the invitee accepts
 *    the e-mailed link and joins with the role; audited `member.invite` as the
 *    agent;
 *  - the super-admin tools (set_workspace_module, takedown_app, restore_app,
 *    set_gallery_hidden) are absent for a regular user and present for the
 *    super-admin; each change asks for user_confirmed first; takedown_app by
 *    the production host → 451, the owner's e-mail and `admin.takedown` as
 *    the agent; restore_app lifts it; set_gallery_hidden hides a listed app;
 *    set_workspace_module enables and disables the opt-in `acmecrm`.
 *
 * The super-admin is `e2e-superadmin@drobek.test` (see abuse.spec.ts).
 */

const SUPER_ADMIN = 'e2e-superadmin@drobek.test';
const SUPER_TOOLS = ['set_workspace_module', 'takedown_app', 'restore_app', 'set_gallery_hidden'];

interface Created {
  app_id: string;
  slug: string;
}

interface MailDetail {
  Subject: string;
  Text: string;
}

async function pollMail(request: APIRequestContext, email: string, subject: string): Promise<MailDetail> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const metas = (await mailpitMessagesFor(request, email.toLowerCase())).filter((m) => (m.Subject ?? '').includes(subject));
    if (metas.length > 0) {
      const res = await request.get(`${MAILPIT_URL}/api/v1/message/${metas[0].ID}`);
      expect(res.ok()).toBeTruthy();
      const mail = (await res.json()) as MailDetail;
      return { ...mail, Text: mail.Text.replace(/\r\n/g, '\n') };
    }
    if (Date.now() > deadline) throw new Error(`no mail "${subject}" for ${email} within 20 s`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function auditRows(where: { action: string; target?: string; workspaceSlug?: string }): Promise<{ actor_kind: string; meta: Record<string, unknown> | null }[]> {
  return withDb(async (c) =>
    (
      await c.query(
        `SELECT a.actor_kind, a.meta FROM audit_log a JOIN workspaces w ON w.id = a.workspace_id
          WHERE a.action = $1 AND ($2::text IS NULL OR a.target = $2) AND ($3::text IS NULL OR w.slug = $3)
          ORDER BY a.created_at`,
        [where.action, where.target ?? null, where.workspaceSlug ?? null]
      )
    ).rows
  );
}

async function createAndPublish(mcp: McpClient, name: string): Promise<Created> {
  const created = await callTool(mcp.client, 'create_app', { name, workspace: mcp.workspace, template: 'html' });
  expect(created.isError, created.text).toBe(false);
  const app = created.json as unknown as Created;
  const p = await callTool(mcp.client, 'publish', { app_id: app.app_id });
  expect(p.isError, p.text).toBe(false);
  return app;
}

test.describe.configure({ mode: 'serial' });

test.describe('workspaces and the operator over MCP @local', () => {
  let owner: McpClient;
  let boss: McpClient | null = null;
  let bossCtx: BrowserContext | null = null;
  let teamSlug: string;

  test.afterAll(async () => {
    await owner?.client.close().catch(() => {});
    await boss?.client.close().catch(() => {});
    await bossCtx?.close().catch(() => {});
  });

  test('create_workspace makes a team workspace with the caller as its admin; a taken slug is slug_taken', async ({ page, request }) => {
    skipUnlessLocal();
    owner = await mcpClient(page, request, { tag: 'mcp-ws-owner', scope: FULL_SCOPE });
    const tools = (await owner.client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['create_workspace', 'invite_member']));
    for (const t of [...SUPER_TOOLS, 'set_workspace_publishing']) expect(tools, t).not.toContain(t);

    teamSlug = `mcp-team-${Date.now().toString(36)}`;
    const created = await callTool(owner.client, 'create_workspace', { name: 'MCP Crew', slug: teamSlug });
    expect(created.isError, created.text).toBe(false);
    expect(created.json).toMatchObject({ workspace: teamSlug, name: 'MCP Crew', kind: 'team', role: 'workspace-admin' });
    expect(String(created.json.workspace_url)).toContain(`/workspaces/${teamSlug}`);

    const listed = await callTool(owner.client, 'list_apps', {});
    expect((listed.json.workspaces as { slug: string; role: string }[]).find((w) => w.slug === teamSlug)).toMatchObject({ role: 'workspace-admin' });

    const again = await callTool(owner.client, 'create_workspace', { name: 'Other', slug: teamSlug });
    expect(again.isError).toBe(true);
    expect(again.json).toMatchObject({ code: 'slug_taken' });

    const personal = await callTool(owner.client, 'invite_member', { workspace: owner.workspace, email: uniqueEmail('mcp-ws-x'), role: 'viewer', user_confirmed: true });
    expect(personal.json).toMatchObject({ code: 'invalid_params' });
  });

  test('invite_member asks first, e-mails the invite without returning the link, and the invitee joins with the role', async ({ browser, request }) => {
    skipUnlessLocal();
    const invitee = uniqueEmail('mcp-ws-invitee');
    const ask = await callTool(owner.client, 'invite_member', { workspace: teamSlug, email: invitee, role: 'editor' });
    expect(ask.isError).toBe(true);
    expect(ask.json).toMatchObject({ code: 'user_confirmation_required', workspace: teamSlug, email: invitee, role: 'editor' });
    expect(await mailpitMessagesFor(request, invitee)).toHaveLength(0);

    const sent = await callTool(owner.client, 'invite_member', { workspace: teamSlug, email: invitee, role: 'editor', user_confirmed: true });
    expect(sent.isError, sent.text).toBe(false);
    expect(sent.json).toMatchObject({ workspace: teamSlug, email: invitee, role: 'editor', invited: true, expires_in_days: 7 });
    expect(sent.text).not.toContain('/invite/');

    const mail = await pollMail(request, invitee, 'invited');
    const link = /https?:\/\/\S+\/invite\/[0-9a-f]{64}/.exec(mail.Text)?.[0];
    expect(link, 'the accept link is in the e-mail').toBeTruthy();

    const ctx = await browser.newContext();
    try {
      const ip = await ctx.newPage();
      await loginViaEmail(ip, request, invitee);
      await ip.goto(link as string);
      await ip.getByRole('button', { name: 'Accept invite' }).click();
      await ip.waitForURL(new RegExp(`/workspaces/${teamSlug}$`));
      await expect(ip.getByTestId('my-role')).toHaveText('editor');
    } finally {
      await ctx.close();
    }

    expect(await auditRows({ action: 'member.invite', workspaceSlug: teamSlug })).toEqual([{ actor_kind: 'agent', meta: { role: 'editor' } }]);
  });

  test('the super-admin gets the operator tools; takedown_app by host → 451, owner e-mail, audit; restore_app lifts it', async ({ browser, request }) => {
    skipUnlessLocal();
    bossCtx = await browser.newContext();
    boss = await mcpClient(await bossCtx.newPage(), request, { email: SUPER_ADMIN, scope: FULL_SCOPE });
    const tools = (await boss.client.listTools()).tools.map((t) => t.name);
    for (const t of SUPER_TOOLS) expect(tools, t).toContain(t);

    const app = await createAndPublish(owner, 'MCP Takedown Probe');
    expect((await hostRequest(prodHost(app.slug), '/')).status).toBe(200);

    const ask = await callTool(boss.client, 'takedown_app', { app: prodHost(app.slug), reason: 'spam' });
    expect(ask.json).toMatchObject({ code: 'user_confirmation_required', app_id: app.app_id, app: app.slug, reason: 'spam', published: true });
    expect((await hostRequest(prodHost(app.slug), '/')).status, 'asking changes nothing').toBe(200);

    const down = await callTool(boss.client, 'takedown_app', { app: prodHost(app.slug), reason: 'spam', user_confirmed: true });
    expect(down.isError, down.text).toBe(false);
    expect(down.json).toMatchObject({ app_id: app.app_id, taken_down: true, reason: 'spam', changed: true });
    expect((await hostRequest(prodHost(app.slug), '/')).status).toBe(451);
    expect((await hostRequest(previewHost(app.slug), '/')).status).toBe(451);
    const refused = await callTool(owner.client, 'publish', { app_id: app.app_id });
    expect(refused.json).toMatchObject({ code: 'app_locked_by_admin' });
    const mail = await pollMail(request, owner.email, `Your app ${app.slug} was taken down`);
    expect(mail.Text).toContain('Spam or scam');
    expect(await auditRows({ action: 'admin.takedown', target: app.slug })).toEqual([expect.objectContaining({ actor_kind: 'agent' })]);

    const back = await callTool(boss.client, 'restore_app', { app: app.slug, user_confirmed: true });
    expect(back.json).toMatchObject({ app_id: app.app_id, taken_down: false, changed: true });
    expect((await hostRequest(previewHost(app.slug), '/')).status).toBe(200);
    await pollMail(request, owner.email, `Your app ${app.slug} was restored`);
    expect(await auditRows({ action: 'admin.restore', target: app.slug })).toEqual([expect.objectContaining({ actor_kind: 'agent' })]);
  });

  test('set_gallery_hidden hides a listed app and shows it again; set_workspace_module switches acmecrm', async () => {
    skipUnlessLocal();
    expect(boss, 'the super-admin client from the takedown test').toBeTruthy();
    const app = await createAndPublish(owner, 'MCP Gallery Probe');
    const listed = await callTool(owner.client, 'set_gallery_listing', {
      app_id: app.app_id,
      listed: true,
      description: 'A probe for the operator tools.',
      user_confirmed: true,
    });
    expect(listed.isError, listed.text).toBe(false);

    const ask = await callTool(boss!.client, 'set_gallery_hidden', { app: app.app_id, hidden: true });
    expect(ask.json).toMatchObject({ code: 'user_confirmation_required', hidden: true, listed: true });
    const hid = await callTool(boss!.client, 'set_gallery_hidden', { app: app.app_id, hidden: true, user_confirmed: true });
    expect(hid.json).toMatchObject({ hidden: true, changed: true });
    const got = await callTool(owner.client, 'get_app', { app_id: app.app_id });
    expect(got.json.gallery).toMatchObject({ hidden_by_admin: true });
    expect(await auditRows({ action: 'app.gallery_hidden', target: app.slug })).toEqual([expect.objectContaining({ actor_kind: 'agent' })]);
    const shown = await callTool(boss!.client, 'set_gallery_hidden', { app: app.slug, hidden: false, user_confirmed: true });
    expect(shown.json).toMatchObject({ hidden: false, changed: true });

    const askModule = await callTool(boss!.client, 'set_workspace_module', { workspace: teamSlug, module: 'acmecrm', enabled: true });
    expect(askModule.json).toMatchObject({ code: 'user_confirmation_required', workspace: teamSlug, module: 'acmecrm', enabled: true });
    const on = await callTool(boss!.client, 'set_workspace_module', { workspace: teamSlug, module: 'acmecrm', enabled: true, user_confirmed: true });
    expect(on.isError, on.text).toBe(false);
    expect(on.json).toMatchObject({ workspace: teamSlug, module: 'acmecrm', switch: true, enabled: true, changed: true });
    expect(await auditRows({ action: 'module.workspace_enable', workspaceSlug: teamSlug })).toEqual([expect.objectContaining({ actor_kind: 'agent' })]);
    const off = await callTool(boss!.client, 'set_workspace_module', { workspace: teamSlug, module: 'acmecrm', enabled: false, user_confirmed: true });
    expect(off.json).toMatchObject({ switch: false, changed: true });
  });
});
