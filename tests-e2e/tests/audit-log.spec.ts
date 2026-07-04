import pg from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import {
  deployClient,
  indexHtml,
  initUploadCommit,
  waitForState,
} from './helpers/deploy';

/**
 * PHY-85 acceptance (governance / audit log v1): who deployed what, when, and was
 * it the AGENT or a HUMAN.
 *   (1) an MCP-driven deploy (OAuth token) writes app.create + deploy.activate
 *       audit rows attributed to the AGENT + the token user; a dashboard rollback
 *       writes deploy.rollback attributed to the USER — same person, different
 *       surface, so actor_kind is derived from the surface, not spoofable.
 *   (2) the workspace Activity view (admin only) lists them, filterable by app +
 *       action; the CSV export matches the filter; a soft-deleted app's prior
 *       events STILL show (the subject is retained — no FK cascade).
 *   (3) a team invite + accept write member.invite (inviter) + member.accept
 *       (accepter); an EDITOR is denied the Activity view (403).
 * Requires the local compose stack + worker (deploys go through the pipeline).
 */

const DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://drobek:drobek@localhost:5441/drobek';

async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

interface AuditRow {
  action: string;
  actor_kind: string;
  actor_user_id: string | null;
  actor_email: string | null;
}

async function auditRowsForSubject(
  wsSlug: string,
  target: string
): Promise<AuditRow[]> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT al.action, al.actor_kind, al.actor_user_id, u.email AS actor_email
         FROM audit_log al
         JOIN workspaces w ON w.id = al.workspace_id
         LEFT JOIN users u ON u.id = al.actor_user_id
        WHERE w.slug = $1 AND al.target = $2
        ORDER BY al.created_at`,
      [wsSlug, target]
    );
    return res.rows as AuditRow[];
  });
}

/** Collect console.error + pageerror problems for a "console clean" assertion. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  return problems;
}

function uniqueSlug(): string {
  return `e2e-audit-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

test('audit: MCP deploy is agent-attributed, dashboard rollback is user-attributed; Activity view + CSV + soft-delete survival @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const problems = watchConsole(page);
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = Math.random().toString(36).slice(2, 8);
    const slug = `audit-${salt}`;

    // Two MCP-driven deploys (agent surface): v1 then v2 (active). One app.create
    // (first deploy only) + one deploy.activate PER deploy.
    const v1 = await initUploadCommit(client, request, {
      name: `Audit ${salt}`,
      slug,
      files: [indexHtml(`v1 ${salt}`)],
    });
    await waitForState(client, v1.deployId, 'ready');
    const v2 = await initUploadCommit(client, request, {
      slug,
      files: [indexHtml(`v2 ${salt}`)],
    });
    const v2ready = await waitForState(client, v2.deployId, 'ready');
    expect(v2ready.active).toBe(true);

    const ws = v1.workspaceSlug; // the deployer's personal workspace (owner = admin)
    const appSlug = v1.appSlug;

    // Dashboard rollback to v1 (USER surface) — the owner is workspace-admin.
    await page.goto(`/workspaces/${ws}/apps/${appSlug}`);
    await page
      .locator(
        `[data-testid="deploy-row"][data-deploy-id="${v1.deployId}"] [data-testid="rollback-button"]`
      )
      .click();
    await expect(
      page.locator(
        `[data-testid="deploy-row"][data-deploy-id="${v1.deployId}"] [data-testid="deploy-active"]`
      )
    ).toBeVisible();

    // ── DB: attribution is correct and not swapped ────────────────────────────
    const rows = await auditRowsForSubject(ws, appSlug);
    const byAction = (a: string) => rows.filter((r) => r.action === a);

    expect(byAction('app.create')).toHaveLength(1);
    expect(byAction('app.create')[0].actor_kind).toBe('agent');

    const activates = byAction('deploy.activate');
    expect(activates, 'exactly one deploy.activate PER deploy').toHaveLength(2);
    expect(activates.every((r) => r.actor_kind === 'agent')).toBe(true);

    const rollbacks = byAction('deploy.rollback');
    expect(rollbacks, 'exactly one deploy.rollback').toHaveLength(1);
    expect(rollbacks[0].actor_kind).toBe('user');

    // Not spoofable / not swapped: no activate is user, no rollback is agent.
    expect(activates.some((r) => r.actor_kind === 'user')).toBe(false);
    expect(rollbacks.some((r) => r.actor_kind === 'agent')).toBe(false);

    // Same person (token user == session user == the workspace owner), which is
    // exactly why actor_kind has to come from the SURFACE, not the user.
    const actorIds = new Set(rows.map((r) => r.actor_user_id));
    expect(actorIds.size, 'one distinct actor').toBe(1);
    const [actorId] = [...actorIds];
    expect(actorId).toBeTruthy();
    const owner = await withDb(async (c) => {
      const res = await c.query(
        `SELECT m.user_id FROM memberships m
           JOIN workspaces w ON w.id = m.workspace_id
          WHERE w.slug = $1`,
        [ws]
      );
      return res.rows[0]?.user_id as string;
    });
    expect(actorId).toBe(owner);

    // ── Activity view (admin) — filterable by action, agent/user badges ───────
    await page.goto(`/workspaces/${ws}/activity`);
    await expect(page.getByTestId('activity-table')).toBeVisible();

    await page.getByTestId('filter-action').selectOption('deploy.activate');
    await page.getByTestId('filter-apply').click();
    const activateRows = page.locator('[data-testid="activity-row"]');
    await expect(activateRows).toHaveCount(2);
    for (const kind of await activateRows.evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-actor-kind'))
    )) {
      expect(kind).toBe('agent');
    }

    await page.goto(`/workspaces/${ws}/activity?action=deploy.rollback`);
    const rollbackRow = page.locator('[data-testid="activity-row"]');
    await expect(rollbackRow).toHaveCount(1);
    await expect(rollbackRow).toHaveAttribute('data-actor-kind', 'user');
    await expect(rollbackRow).toHaveAttribute('data-action', 'deploy.rollback');

    // ── CSV export matches the filtered rows ──────────────────────────────────
    const csvRes = await page.request.get(
      `/workspaces/${ws}/activity/export.csv?action=deploy.rollback`
    );
    expect(csvRes.status()).toBe(200);
    expect(csvRes.headers()['content-type']).toContain('text/csv');
    const csvLines = (await csvRes.text())
      .split('\r\n')
      .filter((l) => l.length > 0);
    expect(csvLines[0]).toBe('time,action,actor_kind,actor,subject_type,subject');
    expect(csvLines).toHaveLength(2); // header + the single rollback row
    const cols = csvLines[1].split(',');
    expect(cols[1]).toBe('deploy.rollback');
    expect(cols[2]).toBe('user');
    expect(cols[5]).toBe(appSlug);

    // The unfiltered export carries all three action kinds for this app.
    const fullCsv = await (
      await page.request.get(`/workspaces/${ws}/activity/export.csv?app=${appSlug}`)
    ).text();
    expect(fullCsv).toContain('app.create');
    expect(fullCsv).toContain('deploy.activate');
    expect(fullCsv).toContain('deploy.rollback');

    // ── Soft-delete the app → its prior audit events STILL show (subject kept) ─
    await withDb(async (c) => {
      const res = await c.query(
        `UPDATE apps SET deleted_at = now()
           WHERE slug = $1
             AND workspace_id = (SELECT id FROM workspaces WHERE slug = $2)`,
        [appSlug, ws]
      );
      expect(res.rowCount).toBe(1);
    });
    await page.goto(`/workspaces/${ws}/activity?app=${appSlug}`);
    await expect(page.getByTestId('activity-table')).toBeVisible();
    // app.create + 2×deploy.activate + deploy.rollback = 4 rows, all retained.
    await expect(page.locator('[data-testid="activity-row"]')).toHaveCount(4);

    await page.waitForTimeout(300);
    expect(problems).toEqual([]);
  } finally {
    await transport.close();
  }
});

test('audit: team invite + accept are attributed; an editor is denied the Activity view (403) @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  const admin = uniqueEmail('audit-admin');
  const editor = uniqueEmail('audit-editor');
  const slug = uniqueSlug();

  // Admin (the default page) creates a team and invites an EDITOR by email.
  await loginViaEmail(page, request, admin);
  await page.goto('/workspaces');
  await page.getByLabel('Team name').fill('Audit Crew');
  await page.getByLabel('Slug').fill(slug);
  await page.getByRole('button', { name: 'Create team' }).click();
  await page.waitForURL(new RegExp(`/workspaces/${slug}$`));

  await page.getByLabel('Email (optional)').fill(editor);
  await page.getByRole('button', { name: 'Create invite' }).click();
  const inviteUrl = (
    await page.getByTestId('invite-link').textContent()
  )?.trim();
  expect(inviteUrl, 'invite link surfaced').toBeTruthy();

  // The editor runs in a SEPARATE browser context so the admin session stays
  // live (avoids logging the same user in twice, which races on the OTP email).
  const editorCtx = await browser.newContext();
  try {
    const editorPage = await editorCtx.newPage();
    await loginViaEmail(editorPage, request, editor);
    await editorPage.goto(inviteUrl as string);
    await editorPage.getByRole('button', { name: 'Accept invite' }).click();
    await editorPage.waitForURL(new RegExp(`/workspaces/${slug}$`));
    await expect(editorPage.getByTestId('my-role')).toHaveText('editor');

    // The editor is DENIED the Activity view (admin+ only) — 403 server-side.
    const denied = await editorPage.request.get(`/workspaces/${slug}/activity`);
    expect(denied.status()).toBe(403);
  } finally {
    await editorCtx.close();
  }

  // ── DB: the two membership events are attributed to the right humans ───────
  const events = await withDb(async (c) => {
    const res = await c.query(
      `SELECT al.action, al.actor_kind, u.email AS actor_email
         FROM audit_log al
         JOIN workspaces w ON w.id = al.workspace_id
         LEFT JOIN users u ON u.id = al.actor_user_id
        WHERE w.slug = $1 AND al.action IN ('member.invite', 'member.accept')`,
      [slug]
    );
    return res.rows as { action: string; actor_kind: string; actor_email: string | null }[];
  });
  const invite = events.find((e) => e.action === 'member.invite');
  const accept = events.find((e) => e.action === 'member.accept');
  expect(invite).toBeTruthy();
  expect(invite!.actor_kind).toBe('user');
  expect(invite!.actor_email).toBe(admin);
  expect(accept).toBeTruthy();
  expect(accept!.actor_kind).toBe('user');
  expect(accept!.actor_email).toBe(editor);

  // ── The admin (still logged in) sees both in the Activity view ────────────
  await page.goto(`/workspaces/${slug}/activity?action=member.invite`);
  const inviteRow = page.locator('[data-testid="activity-row"]');
  await expect(inviteRow).toHaveCount(1);
  await expect(inviteRow).toHaveAttribute('data-actor-kind', 'user');
  await expect(inviteRow.getByTestId('activity-actor')).toContainText(admin);

  await page.goto(`/workspaces/${slug}/activity?action=member.accept`);
  const acceptRow = page.locator('[data-testid="activity-row"]');
  await expect(acceptRow).toHaveCount(1);
  await expect(acceptRow.getByTestId('activity-actor')).toContainText(editor);
});

test('audit: anonymous Activity view redirects to /login @smoke', async ({
  page,
}) => {
  await page.goto('/workspaces/anything/activity');
  await expect(page).toHaveURL(/\/login/);
});
