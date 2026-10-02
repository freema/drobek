import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Redis } from 'ioredis';
import { TEST_ENV } from '../playwright.config';
import { hostRequest, previewHost, prodHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * The app purge: a deleted app is deleted for good APP_PURGE_AFTER_DAYS after
 * the delete (the dev and e2e stacks: 45 days, the purge every 5 s).
 *   (1) the delete form says what goes for good and after how many days;
 *   (2) with `deleted_at` shifted past that (SQL), the next run deletes the
 *       app row and every row of every table that references it — versions,
 *       module data (records, form submissions, end users and identities,
 *       uploads), configs, domains, logs — and the end users' sessions in
 *       Redis; abuse reports keep their row without the reference;
 *   (3) the audit trail stays: `app.delete` and the system's `app.purge`,
 *       shown in the workspace Activity.
 * Module rows and the Redis sessions are SEEDED; the purge itself is the
 * server's own background job.
 */

/** Every column of the public schema that holds an app id (foreign key to apps, or named like one). */
async function appColumns(): Promise<{ table: string; column: string; isArray: boolean }[]> {
  return withDb(async (c) => {
    const res = await c.query(`
      WITH fks AS (
        SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'public.apps'::regclass
      ), named AS (
        SELECT table_name::text AS tbl, column_name::text AS col, data_type = 'ARRAY' AS is_array
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name = 'app_id' OR column_name LIKE '%\\_app\\_id' OR column_name LIKE '%app\\_ids')
      )
      SELECT coalesce(f.tbl, n.tbl) AS table, coalesce(f.col, n.col) AS column, coalesce(n.is_array, false) AS is_array
      FROM fks f FULL JOIN named n ON n.tbl = f.tbl AND n.col = f.col`);
    return res.rows.map((r) => ({ table: r.table as string, column: r.column as string, isArray: r.is_array as boolean }));
  });
}

/** `table.column` → rows that still name the app (only the non-zero ones). */
async function references(appId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const col of await appColumns()) {
    const where = col.isArray ? `$1 = ANY ("${col.column}")` : `"${col.column}" = $1`;
    const n = await withDb(async (c) => (await c.query(`SELECT count(*)::int AS n FROM "${col.table}" WHERE ${where}`, [appId])).rows[0].n as number);
    if (n > 0) out[`${col.table}.${col.column}`] = n;
  }
  return out;
}

async function appExists(appId: string): Promise<boolean> {
  return withDb(async (c) => (await c.query(`SELECT 1 FROM apps WHERE id = $1`, [appId])).rowCount === 1);
}

async function withRedis<T>(fn: (r: Redis) => Promise<T>): Promise<T> {
  const url = process.env.REDIS_URL;
  if (!url || TEST_ENV !== 'local') throw new Error('the purge spec needs TEST_ENV=local and REDIS_URL');
  const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  try {
    return await fn(redis);
  } finally {
    redis.disconnect();
  }
}

test('app purge: a deleted app and everything that references it go for good after APP_PURGE_AFTER_DAYS; the audit trail stays @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  test.setTimeout(120_000);
  const a = await mcpClient(page, request, { tag: 'purge' });
  try {
    const created = await callTool(a.client, 'create_app', { name: `Purge E2E ${Date.now().toString(36)}`, template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;
    expect((await callTool(a.client, 'publish', { app_id: appId })).isError).toBe(false);
    expect((await hostRequest(prodHost(slug))).status).toBe(200);

    // Module data and an abuse report, as the modules and the report form write them.
    const userRow = `eu${randomBytes(8).toString('hex')}`;
    await withDb(async (c) => {
      await c.query(`INSERT INTO module_configs (app_id, module, config) VALUES ($1, 'data', '{}') ON CONFLICT DO NOTHING`, [appId]);
      await c.query(`INSERT INTO mod_data_documents (id, app_id, collection, doc, bytes) VALUES ($1, $2, 'todos', '{"t":"x"}', 9)`, [
        `doc${randomBytes(8).toString('hex')}`,
        appId,
      ]);
      await c.query(`INSERT INTO mod_forms_submissions (id, app_id, form, data) VALUES ($1, $2, 'contact', '{"m":"hi"}')`, [
        `sub${randomBytes(8).toString('hex')}`,
        appId,
      ]);
      await c.query(`INSERT INTO mod_auth_users (id, app_id, email) VALUES ($1, $2, 'ana@example.com')`, [userRow, appId]);
      await c.query(
        `INSERT INTO mod_auth_identities (id, app_id, user_id, provider, issuer, subject) VALUES ($1, $2, $3, 'oidc', 'https://idp.example', 'sub')`,
        [`ei${randomBytes(8).toString('hex')}`, appId, userRow]
      );
      await c.query(`INSERT INTO mod_files (id, app_id, sha256, size, type) VALUES ($1, $2, $3, 5, 'image/png')`, [
        `file${randomBytes(8).toString('hex')}`,
        appId,
        'b'.repeat(64),
      ]);
      await c.query(`INSERT INTO abuse_reports (id, app_id, host, reason) VALUES ($1, $2, $3, 'spam')`, [
        `rep${randomBytes(8).toString('hex')}`,
        appId,
        prodHost(slug),
      ]);
    });
    const sessionKey = `drobek:eu:${appId}:${randomBytes(32).toString('hex')}`;
    const epochKey = `drobek:eu-epoch:${appId}`;
    await withRedis(async (r) => {
      await r.set(sessionKey, JSON.stringify({ id: userRow, email: 'ana@example.com', role: 'user', epoch: 1 }), 'EX', 3600);
      await r.set(epochKey, '1');
    });
    const before = await references(appId);
    for (const table of ['app_versions', 'module_configs', 'mod_data_documents', 'mod_forms_submissions', 'mod_auth_users', 'mod_files', 'abuse_reports']) {
      expect(Object.keys(before).some((k) => k.startsWith(`${table}.`)), `${table} references the app before the purge`).toBe(true);
    }

    // (1) The delete form says what the purge removes and when.
    await page.goto(`/workspaces/${a.workspace}/apps/${slug}/settings`);
    const note = page.getByTestId('delete-purge-note');
    await expect(note).toContainText('for good');
    const purgeDays = Number(await note.getAttribute('data-purge-days'));
    expect(purgeDays).toBeGreaterThan(31);
    await expect(note).toContainText(`${purgeDays} days`);
    await page.getByTestId('delete-confirm-input').fill(slug);
    await page.getByTestId('delete-button').click();
    await page.waitForURL(new RegExp(`/workspaces/${a.workspace}/apps\\?deleted=${slug}$`));
    await expect(page.getByTestId('apps-deleted-notice')).toContainText(`deleted for good after ${purgeDays} days`);
    expect((await hostRequest(previewHost(slug))).status).toBe(404);

    // Before the time is up the app (and its data) stays.
    await withDb((c) => c.query(`UPDATE apps SET deleted_at = deleted_at - make_interval(days => $2) WHERE id = $1`, [appId, purgeDays - 2]));
    await page.waitForTimeout(12_000);
    expect(await appExists(appId)).toBe(true);
    expect(await withRedis((r) => r.exists(sessionKey))).toBe(1);

    // (2) Past APP_PURGE_AFTER_DAYS the background purge deletes it for good.
    await withDb((c) => c.query(`UPDATE apps SET deleted_at = deleted_at - interval '3 days' WHERE id = $1`, [appId]));
    await expect.poll(() => appExists(appId), { timeout: 60_000, intervals: [1_000] }).toBe(false);
    expect(await references(appId)).toEqual({});
    await expect.poll(() => withRedis((r) => r.exists(sessionKey, epochKey)), { timeout: 15_000 }).toBe(0);
    const reports = await withDb(async (c) => (await c.query(`SELECT app_id FROM abuse_reports WHERE host = $1`, [prodHost(slug)])).rows);
    expect(reports).toEqual([{ app_id: null }]);
    expect((await hostRequest(prodHost(slug))).status).toBe(404);

    // (3) The audit trail stays, with the system's app.purge.
    const actions = await withDb(
      async (c) =>
        (await c.query(`SELECT action, actor_user_id, meta FROM audit_log WHERE target = $1 ORDER BY created_at, id`, [slug])).rows as {
          action: string;
          actor_user_id: string | null;
          meta: Record<string, unknown>;
        }[]
    );
    expect(actions.map((r) => r.action)).toEqual(expect.arrayContaining(['app.create', 'app.delete', 'app.purge']));
    expect(actions.find((r) => r.action === 'app.purge')).toMatchObject({ actor_user_id: null, meta: { appId } });
    await page.goto(`/workspaces/${a.workspace}/activity?app=${slug}&action=app.purge`);
    await expect(page.getByTestId('activity-row')).toHaveCount(1);
    await expect(page.getByTestId('activity-summary')).toContainText('Deleted the app’s versions and data for good');
  } finally {
    await a.transport.close();
  }
});
