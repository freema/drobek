import { expect, test } from '@playwright/test';
import {
  loginViaEmail,
  logout,
  skipUnlessLocal,
  uniqueEmail,
} from './helpers/auth';
import { callTool, type McpClient, mcpClient } from './helpers/mcp';
import {
  addMembership,
  seedApp as seedAppRow,
  userIdByEmail,
  workspaceIdBySlug,
} from './helpers/seed';

/**
 * M1b acceptance (PHY-121): the dashboard Data tab (lite). Seed a collection +
 * records via the U10 MCP data tools (on an app SEEDED via SQL), then drive the dashboard UI as the
 * workspace admin: the collections list, the collection table (schema columns,
 * newest-first), a filter + sort round-trip through the U10 query API, a
 * server-streamed CSV export of the filtered rows, a read-only record viewer,
 * and an editor+ confirm-delete. Then: a VIEWER sees the table but no delete
 * affordance and a direct POST to the delete action is 403; a cross-workspace
 * app/collection is unreachable (404). Console must stay clean (no hydration
 * errors). Requires the local compose stack.
 */

const DATA_SCOPE = 'mcp:whoami apps:read data:read data:write';

const SCHEMA = {
  type: 'object',
  required: ['title', 'done'],
  properties: {
    title: { type: 'string' },
    done: { type: 'boolean' },
    priority: { type: 'number' },
  },
};

interface SeededApp {
  ws: string;
  workspaceId: string;
  app: string;
  ids: string[];
}

/**
 * Seed a throwaway app in the token's workspace, define a `todos` collection (LOCKED — the member-view
 * still reads it) + an owner-only `private_notes` collection (which the public/
 * anon path rejects but the owner dashboard may list/read), and seed 4 todos.
 * `delta` carries an extra non-schema key to exercise the per-row expander.
 */
async function seedApp(mcp: McpClient): Promise<SeededApp> {
  const { client } = mcp;
  const workspaceId = await workspaceIdBySlug(mcp.workspace);
  const row = await seedAppRow({ workspaceId });
  const dep = { workspaceSlug: mcp.workspace, appSlug: row.slug };
  const locator = { workspace: dep.workspaceSlug, slug: dep.appSlug };

  const def = await callTool(client, 'collection_define', {
    workspace: dep.workspaceSlug,
    slug: dep.appSlug,
    name: 'todos',
    jsonSchema: SCHEMA,
    accessMode: 'locked',
  });
  expect(def.isError, JSON.stringify(def.json)).toBe(false);

  // owner-only: record ops are rejected on the public/MCP path (not_implemented)
  // — the dashboard member-view must still LIST + open it (regardless of mode).
  const ownerDef = await callTool(client, 'collection_define', {
    workspace: dep.workspaceSlug,
    slug: dep.appSlug,
    name: 'private_notes',
    jsonSchema: SCHEMA,
    accessMode: 'owner-only',
  });
  expect(ownerDef.isError, JSON.stringify(ownerDef.json)).toBe(false);

  const docs = [
    { title: 'alpha', done: false, priority: 3 },
    { title: 'bravo', done: true, priority: 1 },
    { title: 'charlie', done: false, priority: 2 },
    { title: 'delta', done: true, priority: 4, tags: ['x', 'y'] },
  ];
  const ids: string[] = [];
  for (const doc of docs) {
    const r = await callTool(client, 'record_create', {
      locator,
      collection: 'todos',
      doc,
    });
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
    ids.push(r.json.id as string);
  }
  return { ws: dep.workspaceSlug, workspaceId, app: dep.appSlug, ids };
}

test('data tab: collections → table → filter/sort round-trip → CSV → record viewer → delete @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();

  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });

  const mcp = await mcpClient(page, request, {
    tag: 'datatab-admin',
    scope: DATA_SCOPE,
  });
  let seeded: SeededApp;
  try {
    seeded = await seedApp(mcp);
  } finally {
    await mcp.transport.close();
  }
  const { ws, app } = seeded;

  // ── COLLECTIONS LIST ────────────────────────────────────────────────────────
  await page.goto(`/workspaces/${ws}/apps/${app}/data`);
  await expect(page.locator('[data-testid="collection-row"]')).toHaveCount(2);

  const todosRow = page.locator(
    '[data-testid="collection-row"][data-collection="todos"]'
  );
  await expect(todosRow.locator('[data-testid="collection-count"]')).toContainText(
    '4'
  );
  await expect(
    todosRow.locator('[data-testid="collection-access"]')
  ).toContainText('locked');

  // The owner-only collection is listed with its mode + 0 records — proof the
  // member-view is NOT the anon access-mode gate (that path rejects owner-only).
  const ownerRow = page.locator(
    '[data-testid="collection-row"][data-collection="private_notes"]'
  );
  await expect(
    ownerRow.locator('[data-testid="collection-access"]')
  ).toContainText('owner-only');
  await expect(ownerRow.locator('[data-testid="collection-count"]')).toContainText(
    '0'
  );
  // …and its (empty) table opens rather than 501-ing.
  await page.goto(`/workspaces/${ws}/apps/${app}/data/private_notes`);
  await expect(page.locator('[data-testid="records-empty"]')).toBeVisible();

  // ── COLLECTION TABLE (default: newest-first) ─────────────────────────────────
  await page.goto(`/workspaces/${ws}/apps/${app}/data`);
  await todosRow.locator('[data-testid="collection-link"]').click();
  await page.waitForURL(new RegExp(`/apps/${app}/data/todos$`));
  await expect(page.locator('[data-testid="data-table"]')).toBeVisible();
  await expect(page.locator('[data-testid="data-row"]')).toHaveCount(4);
  // `delta` was created last → newest-first puts it in row 0.
  await expect(page.locator('[data-testid="data-row"]').first()).toContainText(
    'delta'
  );

  // ── FILTER (done=true) + SORT (priority asc) round-trip via the U10 query ────
  await page.locator('[data-testid="filter-field"]').selectOption('done');
  await page.locator('[data-testid="filter-value"]').fill('true');
  await page.locator('[data-testid="sort-field"]').selectOption('priority');
  await page.locator('[data-testid="sort-dir"]').selectOption('asc');
  await page.locator('[data-testid="filter-apply"]').click();
  await page.waitForURL(/field=done/);

  const filtered = page.locator('[data-testid="data-row"]');
  await expect(filtered).toHaveCount(2);
  // done=true → bravo(priority 1) + delta(priority 4); sorted asc → bravo, delta.
  await expect(filtered.nth(0)).toContainText('bravo');
  await expect(filtered.nth(1)).toContainText('delta');

  // ── CSV EXPORT (current filter applied, streamed) ────────────────────────────
  const csvRes = await page.request.get(
    `/workspaces/${ws}/apps/${app}/data/todos/export.csv?field=done&value=true&sort=priority&dir=asc`
  );
  expect(csvRes.status()).toBe(200);
  expect(csvRes.headers()['content-type']).toContain('text/csv');
  expect(csvRes.headers()['content-disposition']).toContain('attachment');
  const lines = (await csvRes.text()).trim().split(/\r?\n/);
  expect(lines[0]).toBe('title,done,priority');
  expect(lines).toHaveLength(3); // header + the 2 filtered rows
  expect(lines[1]).toBe('bravo,true,1');
  expect(lines[2]).toBe('delta,true,4');

  // ── RECORD VIEWER (read-only JSON) ───────────────────────────────────────────
  await filtered.nth(0).locator('[data-testid="record-view"]').click();
  await expect(page.locator('[data-testid="record-modal"]')).toBeVisible();
  await expect(page.locator('[data-testid="record-json"]')).toContainText(
    '"title": "bravo"'
  );
  await page.locator('[data-testid="record-close"]').click();
  await expect(page.locator('[data-testid="record-modal"]')).toHaveCount(0);

  // ── DELETE (confirm) → bravo disappears (soft-deleted), filter preserved ─────
  await filtered.nth(0).locator('[data-testid="delete-link"]').click();
  await page.locator('[data-testid="delete-confirm"]').click();
  await page.waitForURL(/field=done/);
  await expect(page.locator('[data-testid="data-row"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="data-row"]').first()).toContainText(
    'delta'
  );
  await expect(page.locator('[data-testid="data-table"]')).not.toContainText(
    'bravo'
  );
  // delta carries an extra (non-schema) key → the per-row expander is present.
  await expect(page.locator('[data-testid="row-extra"]')).toHaveCount(1);

  // Give hydration a beat, then assert the console stayed clean throughout.
  await page.waitForTimeout(400);
  expect(problems).toEqual([]);
});

test('data tab: a viewer sees the table but cannot delete (no control, POST 403) @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();

  const mcp = await mcpClient(page, request, {
    tag: 'datatab-owner',
    scope: DATA_SCOPE,
  });
  let seeded: SeededApp;
  try {
    seeded = await seedApp(mcp);
  } finally {
    await mcp.transport.close();
  }
  const { ws, app, ids } = seeded;

  // A different user signs in and is seeded as a VIEWER of the owner's workspace.
  const viewerEmail = uniqueEmail('datatab-viewer');
  await logout(page);
  await loginViaEmail(page, request, viewerEmail);
  await addMembership(
    await userIdByEmail(viewerEmail),
    seeded.workspaceId,
    'viewer'
  );

  // The viewer sees the full table (read-only)…
  await page.goto(`/workspaces/${ws}/apps/${app}/data/todos`);
  await expect(page.locator('[data-testid="data-table"]')).toBeVisible();
  await expect(page.locator('[data-testid="data-row"]')).toHaveCount(4);
  // …can open the read-only viewer…
  await expect(page.locator('[data-testid="record-view"]').first()).toBeVisible();
  // …but has NO delete affordance anywhere.
  await expect(page.locator('[data-testid="delete-link"]')).toHaveCount(0);

  // A direct POST to the delete action is rejected server-side (editor gate).
  const res = await page.request.post(
    `/workspaces/${ws}/apps/${app}/data/todos`,
    { form: { intent: 'delete', id: ids[0] } }
  );
  expect(res.status()).toBe(403);

  // The blocked POST changed nothing — all 4 records remain.
  await page.reload();
  await expect(page.locator('[data-testid="data-row"]')).toHaveCount(4);
});

test('data tab: a collection/app in another workspace is not reachable (404) @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();

  // Owner A seeds an app + collection in A's workspace.
  const a = await mcpClient(page, request, {
    tag: 'datatab-xws-a',
    scope: DATA_SCOPE,
  });
  let seeded: SeededApp;
  try {
    seeded = await seedApp(a);
  } finally {
    await a.transport.close();
  }
  const { ws, app } = seeded;

  // User B (isolated context) is NOT a member of A's workspace.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await loginViaEmail(pageB, request, uniqueEmail('datatab-xws-b'));
  try {
    for (const path of [
      `/workspaces/${ws}/apps/${app}/data`,
      `/workspaces/${ws}/apps/${app}/data/todos`,
      `/workspaces/${ws}/apps/${app}/data/todos/export.csv`,
    ]) {
      const res = await pageB.request.get(path);
      expect(res.status(), `${path} must 404 for a non-member`).toBe(404);
    }
  } finally {
    await pageB.close();
    await ctxB.close();
  }
});
