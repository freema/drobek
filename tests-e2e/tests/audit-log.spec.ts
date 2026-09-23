import { expect, test, type Page } from '@playwright/test';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import {
  personalWorkspaceOf,
  seedApp,
  seedVersion,
  userIdByEmail,
  withDb,
} from './helpers/seed';

/**
 * PHY-85 acceptance (governance / audit log v1): who published what, when, and
 * was it the AGENT or a HUMAN.
 *   (1) a dashboard publish (and a publish of an older version = the rollback)
 *       writes `app.publish` attributed to the USER with {version,
 *       previousVersion} meta — actor_kind is derived server-side from the
 *       surface, so a spoofed form field cannot flip it.
 *   (2) the workspace Activity view (admin only) lists them, filterable by app +
 *       action; the CSV export matches the filter; a soft-deleted app's prior
 *       events STILL show (the subject is retained — no FK cascade).
 *   (3) a team invite + accept write member.invite (inviter) + member.accept
 *       (accepter); an EDITOR is denied the Activity view (403).
 * No remaining MCP tool writes an audit row (the agent-side writers — version
 * writes via MCP — are not exposed yet), so agent attribution is covered by the
 * unit tests only. Apps + versions are SEEDED via SQL.
 */

interface AuditRow {
  action: string;
  actor_kind: string;
  actor_user_id: string | null;
  actor_email: string | null;
  meta: Record<string, unknown> | null;
}

async function auditRowsForSubject(
  wsSlug: string,
  target: string
): Promise<AuditRow[]> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT al.action, al.actor_kind, al.actor_user_id, u.email AS actor_email,
              al.meta
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

test('audit: dashboard publish is user-attributed (not spoofable); Activity view + CSV + soft-delete survival @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();

  // The owner signs in → personal workspace (owner = workspace-admin), then an
  // app with two compiled versions is seeded (seeding writes NO audit rows, so
  // every audit row below comes from the dashboard publishes).
  const email = uniqueEmail('audit-owner');
  await loginViaEmail(page, request, email);
  // Watch the console from here on (the login helper's navigation away from
  // /me can abort a harmless route-manifest prefetch).
  await page.waitForLoadState('networkidle');
  const problems = watchConsole(page);
  const ws = await personalWorkspaceOf(email);
  const ownerId = await userIdByEmail(email);
  const app = await seedApp({ workspaceId: ws.id });
  const v1 = await seedVersion({ appId: app.id });
  const v2 = await seedVersion({ appId: app.id });
  const appSlug = app.slug;

  // (a) Publish v2 via the UI (nothing published before).
  await page.goto(`/workspaces/${ws.slug}/apps/${appSlug}`);
  await page
    .locator('[data-testid="publish-button"][data-version="2"]')
    .click();
  await expect(
    page.locator(
      '[data-testid="version-row"][data-version="2"] [data-testid="version-published"]'
    )
  ).toBeVisible();
  // Let the post-publish revalidation + route discovery settle before leaving.
  await page.waitForLoadState('networkidle');

  // (b) Publish v1 (the rollback) via a direct POST that tries to SPOOF the
  // actor kind — the server derives it from the surface and ignores the form.
  const spoof = await page.request.post(`/workspaces/${ws.slug}/apps/${appSlug}`, {
    form: { versionId: v1.id, actorKind: 'agent', actor_kind: 'agent' },
    maxRedirects: 0,
  });
  expect([302, 303, 204]).toContain(spoof.status());
  const published = await withDb(async (c) => {
    const res = await c.query(`SELECT published_version_id FROM apps WHERE id = $1`, [
      app.id,
    ]);
    return res.rows[0].published_version_id as string;
  });
  expect(published).toBe(v1.id);
  expect(v2.id).not.toBe(v1.id);

  // ── DB: exactly two app.publish rows, both USER-attributed to the owner ─────
  const rows = await auditRowsForSubject(ws.slug, appSlug);
  expect(rows.map((r) => r.action)).toEqual(['app.publish', 'app.publish']);
  expect(rows.every((r) => r.actor_kind === 'user')).toBe(true);
  expect(rows.every((r) => r.actor_user_id === ownerId)).toBe(true);
  expect(rows.map((r) => r.meta)).toEqual([
    { version: 2, previousVersion: null },
    { version: 1, previousVersion: 2 },
  ]);

  // ── Activity view (admin) — filterable by app + action, user badges ───────
  await page.goto(`/workspaces/${ws.slug}/activity`);
  await expect(page.getByTestId('activity-table')).toBeVisible();
  await page.getByTestId('filter-app').selectOption(appSlug);
  await page.getByTestId('filter-action').selectOption('app.publish');
  await page.getByTestId('filter-apply').click();
  await page.waitForURL(/action=app\.publish/);
  const publishRows = page.locator('[data-testid="activity-row"]');
  await expect(publishRows).toHaveCount(2);
  for (const row of await publishRows.all()) {
    await expect(row).toHaveAttribute('data-actor-kind', 'user');
    await expect(row).toHaveAttribute('data-action', 'app.publish');
    await expect(row.getByTestId('activity-actor')).toContainText(email);
    await expect(row.getByTestId('activity-subject')).toContainText(appSlug);
  }

  // ── CSV export matches the filtered rows ──────────────────────────────────
  const csvRes = await page.request.get(
    `/workspaces/${ws.slug}/activity/export.csv?app=${appSlug}&action=app.publish`
  );
  expect(csvRes.status()).toBe(200);
  expect(csvRes.headers()['content-type']).toContain('text/csv');
  const csvLines = (await csvRes.text())
    .split('\r\n')
    .filter((l) => l.length > 0);
  expect(csvLines[0]).toBe('time,action,actor_kind,actor,subject_type,subject');
  expect(csvLines).toHaveLength(3); // header + the two publish rows
  for (const line of csvLines.slice(1)) {
    const cols = line.split(',');
    expect(cols[1]).toBe('app.publish');
    expect(cols[2]).toBe('user');
    expect(cols[3]).toBe(email);
    expect(cols[4]).toBe('app');
    expect(cols[5]).toBe(appSlug);
  }

  // A filter that matches nothing for this app exports only the header.
  const none = await (
    await page.request.get(
      `/workspaces/${ws.slug}/activity/export.csv?app=${appSlug}&action=member.invite`
    )
  ).text();
  expect(none.split('\r\n').filter((l) => l.length > 0)).toHaveLength(1);

  // ── Soft-delete the app → its prior audit events STILL show (subject kept) ─
  await withDb(async (c) => {
    const res = await c.query(`UPDATE apps SET deleted_at = now() WHERE id = $1`, [
      app.id,
    ]);
    expect(res.rowCount).toBe(1);
  });
  await page.goto(`/workspaces/${ws.slug}/activity?app=${appSlug}`);
  await expect(page.getByTestId('activity-table')).toBeVisible();
  await expect(page.locator('[data-testid="activity-row"]')).toHaveCount(2);

  await page.waitForTimeout(300);
  expect(problems).toEqual([]);
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
