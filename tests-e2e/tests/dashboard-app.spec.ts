import { inflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { Redis } from 'ioredis';
import { TEST_ENV } from '../playwright.config';
import { hostRequest, prodHost, previewHost, urlOf, versionHost } from './helpers/apps-host';
import { loginViaEmail, logout, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import {
  addMembership,
  personalWorkspaceOf,
  publishVersion,
  seedApp,
  seedVersion,
  userIdByEmail,
  withDb,
} from './helpers/seed';

/**
 * M2-01 (NSO-288) acceptance — the app page of the dashboard:
 *   (1) publish / rollback / restore / unpublish from the UI change what the
 *       apps host serves (production, preview, `--v<N>`), all audited;
 *   (2) a viewer sees the app, its versions, files and settings but no
 *       action, and every mutating POST is 403 (nothing changes);
 *   (3) the header shows an agent's single-writer lease; "Unlock" removes it
 *       and writes `app.lock.release`; a restore under another member's
 *       lease is refused (409);
 *   (4) the Files tab: tree, read-only viewer (escaped), and the version ZIP
 *       holds the sources AND the build;
 *   (5) Settings: password visibility + frame-ancestors change the apps host;
 *   (6) delete: every host 404, gone from the list / MCP, the slug is taken
 *       for 30 days and free after them — tested by shifting `deleted_at`
 *       back 31 days in SQL and asking create_app for the slug: createApp
 *       releases a slug whose app was deleted 30+ days ago on demand, with
 *       the SAME `releaseDeletedAppSlugs` the hourly sweep runs (unit-tested
 *       with an injected clock in packages/apps/src/lifecycle.test.ts).
 * Apps + versions for (1), (2), (4), (5) are SEEDED via SQL (helpers/seed.ts);
 * (3) and (6) drive the real MCP tools. App hosts are requested over
 * node:http(s) with an explicit Host (helpers/apps-host.ts).
 */

const HTML = (text: string) => `<!doctype html><html><head><title>${text}</title></head><body><h1>${text}</h1></body></html>`;

function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

async function auditActions(slug: string): Promise<{ action: string; actor_kind: string; actor_user_id: string | null; meta: unknown }[]> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT action, actor_kind, actor_user_id, meta FROM audit_log WHERE target = $1 ORDER BY created_at, id`,
      [slug]
    );
    return res.rows;
  });
}

async function appRow(id: string): Promise<{ slug: string; published_version_id: string | null; deleted_at: Date | null; visibility: string; frame_ancestors: string | null }> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT slug, published_version_id, deleted_at, visibility, frame_ancestors FROM apps WHERE id = $1`,
      [id]
    );
    return res.rows[0];
  });
}

/** Write a lease exactly like @drobek/mcp does (local Redis only). */
async function setLease(appId: string, holderUserId: string): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url || TEST_ENV !== 'local') throw new Error('setLease needs TEST_ENV=local and REDIS_URL');
  const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  try {
    const now = Date.now();
    await redis.set(
      `drobek:applock:${appId}`,
      JSON.stringify({
        holder_user_id: holderUserId,
        session_id: 'e2e',
        expires_at: new Date(now + 180_000).toISOString(),
        renewed_at: new Date(now).toISOString(),
      }),
      'PX',
      180_000
    );
  } finally {
    redis.disconnect();
  }
}

/** A minimal ZIP reader (central directory → entries), as the dashboard writes them. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd, 'end of central directory').toBeGreaterThanOrEqual(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nlen + elen + clen;
  }
  return out;
}

test('app page: publish, rollback, restore and unpublish from the UI change what the apps host serves @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('dash-app');
  await loginViaEmail(page, request, email);
  await page.waitForLoadState('networkidle');
  const problems = watchConsole(page);
  const ws = await personalWorkspaceOf(email);
  const userId = await userIdByEmail(email);

  const app = await seedApp({ workspaceId: ws.id });
  await seedVersion({ appId: app.id, files: [{ path: 'index.html', content: HTML('one') }], reasoning: 'first cut' });
  await seedVersion({ appId: app.id, files: [{ path: 'index.html', content: HTML('two') }], reasoning: 'second cut' });
  const row = (n: number) => page.locator(`[data-testid="version-row"][data-version="${n}"]`);

  // Nothing published yet: production 404, the preview serves the newest (v2).
  expect((await hostRequest(prodHost(app.slug))).status).toBe(404);
  expect((await hostRequest(previewHost(app.slug))).body).toContain('<h1>two</h1>');

  await page.goto(`/workspaces/${ws.slug}/apps/${app.slug}`);
  await expect(page.getByTestId('app-header')).toBeVisible();
  await expect(page.getByTestId('app-published-version')).toContainText('not published');
  await expect(page.getByTestId('app-preview-url')).toHaveAttribute('href', urlOf(previewHost(app.slug)));
  await expect(page.getByTestId('app-compile-status')).toHaveAttribute('data-status', 'ok');
  await expect(page.locator('[data-testid="app-tab"][aria-current="page"]')).toHaveAttribute('data-tab', 'overview');
  // "Open" goes to the version host (a link, never a frame).
  await expect(row(2).getByTestId('version-open-link')).toHaveAttribute('href', urlOf(versionHost(app.slug, 2)));
  expect((await hostRequest(versionHost(app.slug, 1))).body).toContain('<h1>one</h1>');

  // ── Publish v2 → production serves "two". ────────────────────────────────
  await row(2).getByTestId('publish-button').click();
  await expect(row(2).getByTestId('version-published')).toBeVisible();
  await expect(page.getByTestId('app-published-version')).toHaveText('v2');
  await expect(page.getByTestId('app-prod-url')).toHaveAttribute('href', urlOf(prodHost(app.slug)));
  expect((await hostRequest(prodHost(app.slug))).body).toContain('<h1>two</h1>');

  // ── Restore v1 to the working copy → v3 = v1's files; preview "one", production still "two".
  await row(1).getByTestId('restore-button').click();
  await expect(row(3)).toBeVisible();
  await expect(row(3)).toContainText('Restore of version 1');
  await expect(row(3)).toContainText(email);
  expect((await hostRequest(previewHost(app.slug))).body).toContain('<h1>one</h1>');
  expect((await hostRequest(prodHost(app.slug))).body).toContain('<h1>two</h1>');

  // ── Rollback: publish v1 → production serves "one". ──────────────────────
  await row(1).getByTestId('publish-button').click();
  await expect(row(1).getByTestId('version-published')).toBeVisible();
  await expect(page.getByTestId('version-published')).toHaveCount(1);
  expect((await hostRequest(prodHost(app.slug))).body).toContain('<h1>one</h1>');

  // ── Unpublish → production 404, the preview keeps serving. ───────────────
  await page.getByTestId('unpublish-button').click();
  await expect(page.getByTestId('app-published-version')).toContainText('not published');
  await expect(page.getByTestId('version-published')).toHaveCount(0);
  await expect(page.getByTestId('unpublish-button')).toHaveCount(0);
  expect((await hostRequest(prodHost(app.slug))).status).toBe(404);
  expect((await hostRequest(previewHost(app.slug))).status).toBe(200);
  expect((await appRow(app.id)).published_version_id).toBeNull();

  // Every step is audited, attributed to the human user (not the agent).
  const audit = await auditActions(app.slug);
  expect(audit.map((a) => a.action)).toEqual(['app.publish', 'app.version.restore', 'app.publish', 'app.unpublish']);
  expect(audit.every((a) => a.actor_kind === 'user' && a.actor_user_id === userId)).toBe(true);
  expect(audit[3].meta).toEqual({ previousVersion: 1 });

  await page.waitForLoadState('networkidle');
  expect(problems).toEqual([]);
});

test('app page: a viewer sees versions, files and settings but no action; every POST is 403 @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const ownerEmail = uniqueEmail('dash-app-owner');
  await loginViaEmail(page, request, ownerEmail);
  const ws = await personalWorkspaceOf(ownerEmail);
  const ownerId = await userIdByEmail(ownerEmail);
  const app = await seedApp({ workspaceId: ws.id });
  const v1 = await seedVersion({ appId: app.id, files: [{ path: 'index.html', content: HTML('one') }] });
  const v2 = await seedVersion({ appId: app.id, files: [{ path: 'index.html', content: HTML('two') }] });
  await publishVersion(app.id, v2.id);
  // An agent of the owner holds the write lease.
  await setLease(app.id, ownerId);

  const viewerEmail = uniqueEmail('dash-app-viewer');
  await logout(page);
  await loginViaEmail(page, request, viewerEmail);
  await addMembership(await userIdByEmail(viewerEmail), ws.id, 'viewer');
  const base = `/workspaces/${ws.slug}/apps/${app.slug}`;

  // Overview: everything readable, no control.
  await page.goto(base);
  await expect(page.locator('[data-testid="version-row"]')).toHaveCount(2);
  await expect(page.getByTestId('app-published-version')).toHaveText('v2');
  await expect(page.getByTestId('app-lock')).toContainText(ownerEmail);
  await expect(page.getByTestId('version-open-link')).toHaveCount(2);
  for (const id of ['publish-button', 'restore-button', 'unpublish-button', 'unlock-button']) {
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }

  // Files: readable + downloadable.
  await page.goto(`${base}/files`);
  await expect(page.getByTestId('file-content')).toContainText('<h1>two</h1>');
  await expect(page.getByTestId('files-download-link')).toBeVisible();

  // Settings: the values, no forms.
  await page.goto(`${base}/settings`);
  await expect(page.getByTestId('settings-visibility-current')).toHaveText('public');
  for (const id of ['visibility-form', 'frame-ancestors-form', 'delete-button']) {
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }

  // Every mutation, posted directly, is refused before anything changes.
  const forms: Record<string, string>[] = [
    { versionId: v1.id },
    { intent: 'publish', versionId: v1.id },
    { intent: 'restore', version: '1' },
    { intent: 'unpublish' },
    { intent: 'unlock' },
    { intent: 'visibility', visibility: 'password', password: 'correct horse' },
    { intent: 'frame-ancestors', frameAncestors: 'https://intranet.example.com' },
    { intent: 'delete', confirm: app.slug },
  ];
  for (const path of [base, `${base}/settings`]) {
    for (const form of forms) {
      const res = await page.request.post(path, { form, maxRedirects: 0 });
      expect(res.status(), `${path} ${JSON.stringify(form)}`).toBe(403);
    }
  }
  const after = await appRow(app.id);
  expect(after).toMatchObject({ published_version_id: v2.id, deleted_at: null, visibility: 'public', frame_ancestors: null });
  expect((await auditActions(app.slug)).map((a) => a.action)).toEqual([]);
  // The lease is still there.
  await page.goto(base);
  await expect(page.getByTestId('app-lock')).toBeVisible();
});

test('app page: the agent lock shows in the header; Unlock removes it and audits app.lock.release @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const a = await mcpClient(page, request, { tag: 'dash-lock' });
  try {
    const userId = await userIdByEmail(a.email);
    const created = await callTool(a.client, 'create_app', { name: 'Lock E2E', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;
    // A write takes the single-writer lease.
    const written = await callTool(a.client, 'write_files', {
      app_id: appId,
      files: [{ path: 'index.html', content: HTML('locked') }],
      reasoning: 'Take the write lease',
    });
    expect(written.isError, written.text).toBe(false);
    expect((await callTool(a.client, 'get_app', { app_id: appId })).json.locked_by).toBeTruthy();

    const base = `/workspaces/${a.workspace}/apps/${slug}`;
    await page.goto(base);
    await expect(page.getByTestId('app-lock')).toBeVisible();
    await expect(page.getByTestId('app-lock-text')).toContainText('Your agent');
    await expect(page.getByTestId('app-lock-text')).toContainText('last write');

    // Unlock from another tab of the app → back on that tab, lock gone.
    await page.goto(`${base}/files`);
    await page.getByTestId('unlock-button').click();
    await page.waitForURL(new RegExp(`${base}/files$`));
    await expect(page.getByTestId('app-lock')).toHaveCount(0);
    expect((await callTool(a.client, 'get_app', { app_id: appId })).json.locked_by).toBeUndefined();

    const rows = (await auditActions(slug)).filter((r) => r.action === 'app.lock.release');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_kind: 'user', actor_user_id: userId });
    expect(rows[0].meta).toMatchObject({ previousHolderUserId: userId });

    // Another member's agent holds the lease → a dashboard restore is refused (409).
    await setLease(appId, 'someone-else');
    await page.goto(base);
    await expect(page.getByTestId('app-lock')).toContainText('a former member');
    await page.locator('[data-testid="restore-button"][data-version="1"]').click();
    await expect(page.getByTestId('action-error')).toContainText('unlock it first');
    const refused = await page.request.post(base, { form: { intent: 'restore', version: '1' }, maxRedirects: 0 });
    expect(refused.status()).toBe(409);
    // Unlock, then the restore goes through.
    await page.getByTestId('unlock-button').click();
    await expect(page.getByTestId('app-lock')).toHaveCount(0);
    await page.locator('[data-testid="restore-button"][data-version="1"]').click();
    await expect(page.locator('[data-testid="version-row"][data-version="3"]')).toContainText('Restore of version 1');
  } finally {
    await a.transport.close();
  }
});

test('app page: Files tab shows the tree and an escaped viewer; the version ZIP holds sources AND build @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('dash-files');
  await loginViaEmail(page, request, email);
  await page.waitForLoadState('networkidle');
  const problems = watchConsole(page);
  const ws = await personalWorkspaceOf(email);
  const app = await seedApp({ workspaceId: ws.id });
  const main = 'const answer = 42;\n// <img src=x onerror="window.__xss=1">\ndocument.body.append(String(answer));\n';
  await seedVersion({
    appId: app.id,
    files: [
      { path: 'index.html', content: HTML('files') },
      { path: 'src/main.tsx', content: main },
      { path: 'main.js', content: 'console.log("built");', kind: 'built' },
    ],
  });
  await seedVersion({ appId: app.id, files: [{ path: 'index.html', content: HTML('later') }] });

  const base = `/workspaces/${ws.slug}/apps/${app.slug}`;
  // From the Overview: v1's "Files" link opens the tab on that version.
  await page.goto(base);
  await page.locator('[data-testid="version-files-link"][data-version="1"]').click();
  await page.waitForURL(new RegExp(`${base}/files\\?version=1$`));
  await expect(page.locator('[data-testid="app-tab"][aria-current="page"]')).toHaveAttribute('data-tab', 'files');

  const tree = page.getByTestId('file-tree');
  await expect(tree.locator('[data-testid="file-link"][data-kind="source"]')).toHaveCount(2);
  await expect(tree.locator('[data-testid="file-link"][data-path="main.js"][data-kind="built"]')).toHaveCount(1);
  // index.html opens by default.
  await expect(page.getByTestId('file-viewer-path')).toHaveText('source/index.html');
  await expect(page.getByTestId('file-content')).toContainText('<h1>files</h1>');

  await tree.locator('[data-testid="file-link"][data-path="src/main.tsx"]').click();
  await expect(page.getByTestId('file-viewer-path')).toHaveText('source/src/main.tsx');
  await expect(page.getByTestId('file-content')).toContainText('const answer = 42;');
  // Highlighted as spans, and the markup in the source stays text.
  await expect(page.getByTestId('file-content').locator('span', { hasText: /^const$/ })).toHaveCount(1);
  await expect(page.getByTestId('file-content').locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  // ── The ZIP (UI download + the raw response). ────────────────────────────
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('files-download-link').click()]);
  expect(download.suggestedFilename()).toBe(`${app.slug}-v1.zip`);

  const res = await page.request.get(`${base}/files/download?version=1`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/zip');
  expect(res.headers()['content-disposition']).toBe(`attachment; filename="${app.slug}-v1.zip"`);
  const zip = readZip(await res.body());
  const root = `${app.slug}-v1`;
  expect([...zip.keys()].sort()).toEqual([`${root}/built/main.js`, `${root}/source/index.html`, `${root}/source/src/main.tsx`]);
  expect(zip.get(`${root}/source/src/main.tsx`)?.toString()).toBe(main);
  expect(zip.get(`${root}/built/main.js`)?.toString()).toBe('console.log("built");');

  expect((await page.request.get(`${base}/files/download?version=9`)).status()).toBe(404);
  await page.waitForLoadState('networkidle');
  expect(problems).toEqual([]);
});

test('app page: Settings — password visibility and frame-ancestors change the apps host @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('dash-settings');
  await loginViaEmail(page, request, email);
  const ws = await personalWorkspaceOf(email);
  const app = await seedApp({ workspaceId: ws.id });
  const v1 = await seedVersion({ appId: app.id, files: [{ path: 'index.html', content: HTML('gated') }] });
  await publishVersion(app.id, v1.id);
  expect((await hostRequest(prodHost(app.slug))).status).toBe(200);

  const settings = `/workspaces/${ws.slug}/apps/${app.slug}/settings`;
  await page.goto(settings);

  // Password without a password → refused; with one → every host is gated.
  await page.getByTestId('visibility-password').check();
  await page.getByTestId('visibility-save').click();
  await expect(page.getByTestId('action-error')).toContainText('Set a password');
  await page.getByTestId('visibility-password').check();
  await page.getByTestId('password-input').fill('correct horse');
  await page.getByTestId('visibility-save').click();
  await expect(page.getByTestId('settings-visibility-current')).toHaveText('password');
  await expect(page.getByTestId('app-visibility')).toHaveText('password');
  const gated = await hostRequest(prodHost(app.slug));
  expect(gated.status).toBe(401);
  expect(gated.body).toContain('This app is password protected');
  expect((await hostRequest(previewHost(app.slug))).status).toBe(401);

  // Back to public.
  await page.getByTestId('visibility-public').check();
  await page.getByTestId('visibility-save').click();
  await expect(page.getByTestId('settings-visibility-current')).toHaveText('public');
  expect((await hostRequest(prodHost(app.slug))).status).toBe(200);

  // Embedding: an invalid value is refused, a valid one reaches the CSP.
  await page.getByTestId('frame-ancestors-input').fill("https://x.example.com; script-src *");
  await page.getByTestId('frame-ancestors-save').click();
  await expect(page.getByTestId('action-error')).toContainText('origins');
  await page.getByTestId('frame-ancestors-input').fill('https://intranet.example.com');
  await page.getByTestId('frame-ancestors-save').click();
  await expect(page.getByTestId('settings-frame-ancestors-current')).toHaveText('https://intranet.example.com');
  const csp = String((await hostRequest(prodHost(app.slug))).headers['content-security-policy']);
  expect(csp).toContain('frame-ancestors https://intranet.example.com');
  await page.getByTestId('frame-ancestors-input').fill('');
  await page.getByTestId('frame-ancestors-save').click();
  await expect(page.getByTestId('settings-frame-ancestors-current')).toHaveText("'none'");
  expect(String((await hostRequest(prodHost(app.slug))).headers['content-security-policy'])).toContain(
    "frame-ancestors 'none'"
  );

  const actions = (await auditActions(app.slug)).map((a) => a.action);
  expect(actions).toEqual([
    'app.visibility.password',
    'app.visibility.public',
    'app.frame_ancestors.change',
    'app.frame_ancestors.change',
  ]);
  // The password hash never reaches the audit trail.
  expect(JSON.stringify(await auditActions(app.slug))).not.toContain('scrypt');
});

test('app page: delete → every host 404, gone from list + MCP; the slug is free 30 days later (SQL time shift) @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const a = await mcpClient(page, request, { tag: 'dash-delete' });
  try {
    const name = `Delete E2E ${Date.now().toString(36)}`;
    const created = await callTool(a.client, 'create_app', { name, template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;
    expect((await callTool(a.client, 'publish', { app_id: appId })).isError).toBe(false);
    expect((await hostRequest(prodHost(slug))).status).toBe(200);

    const base = `/workspaces/${a.workspace}/apps/${slug}`;
    await page.goto(`${base}/settings`);
    // The confirmation must repeat the slug.
    await page.getByTestId('delete-confirm-input').fill('not-the-slug');
    await page.getByTestId('delete-button').click();
    await expect(page.getByTestId('action-error')).toContainText(slug);
    expect((await appRow(appId)).deleted_at).toBeNull();

    await page.getByTestId('delete-confirm-input').fill(slug);
    await page.getByTestId('delete-button').click();
    await page.waitForURL(new RegExp(`/workspaces/${a.workspace}/apps\\?deleted=${slug}$`));
    await expect(page.getByTestId('apps-deleted-notice')).toContainText(slug);
    await expect(page.locator(`[data-testid="app-row"][data-app-slug="${slug}"]`)).toHaveCount(0);

    // Every host of the app answers 404 at once (the serve cache was busted).
    expect((await hostRequest(prodHost(slug))).status).toBe(404);
    expect((await hostRequest(previewHost(slug))).status).toBe(404);
    expect((await hostRequest(versionHost(slug, 1))).status).toBe(404);
    // …the dashboard and MCP do not know it any more.
    expect((await page.goto(base))?.status()).toBe(404);
    const got = await callTool(a.client, 'get_app', { app_id: appId });
    expect(got.isError).toBe(true);
    expect(got.json.code).toBe('not_found');
    const listed = await callTool(a.client, 'list_apps', {});
    expect((listed.json.apps as { app_id: string }[]).map((x) => x.app_id)).not.toContain(appId);
    const del = (await auditActions(slug)).filter((r) => r.action === 'app.delete');
    expect(del).toHaveLength(1);
    expect(del[0].actor_kind).toBe('user');

    // Inside the 30 days the slug stays taken: create_app gets a variant.
    const early = await callTool(a.client, 'create_app', { name: slug, template: 'html' });
    expect(early.isError, early.text).toBe(false);
    expect(early.json.slug).not.toBe(slug);
    expect(String(early.json.slug)).toMatch(new RegExp(`^${slug}-[0-9a-f]{4}$`));

    // 31 days later (shifted in SQL) the slug is released to its tombstone
    // and the same create_app gets it.
    await withDb((c) =>
      c.query(`UPDATE apps SET deleted_at = deleted_at - interval '31 days' WHERE id = $1`, [appId])
    );
    const later = await callTool(a.client, 'create_app', { name: slug, template: 'html' });
    expect(later.isError, later.text).toBe(false);
    expect(later.json.slug).toBe(slug);
    expect(later.json.app_id).not.toBe(appId);
    expect((await appRow(appId)).slug).toBe(`${slug}~deleted-${appId}`);
    expect((await auditActions(slug)).map((r) => r.action)).toContain('app.slug_release');
    // The new app is a different app on the same address.
    expect((await hostRequest(previewHost(slug))).status).toBe(200);
  } finally {
    await a.transport.close();
  }
});
