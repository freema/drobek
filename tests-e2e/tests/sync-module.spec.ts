import { randomBytes } from 'node:crypto';
import { expect, test, type BrowserContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * The built-in platform module `sync` end to end (DROBEK_MODULES=…,sync
 * in the composes, SYNC_PAUSE_AFTER_FAILURES 2 there). The in-network
 * `proxy-echo` serves `/sync/players` only with the injected bearer key and
 * `/sync/fail` always fails:
 *
 *  - a bearer upstream registered in the dashboard, assigned to the app with
 *    `call: "none"` (no browser caller) and a sync source into a `players`
 *    collection — each waits for the owner;
 *  - sync_now writes the feed into the collection (the data API and
 *    query_data show it); the secret never appears in a tool answer;
 *  - a failing source: two failed runs pause it, the app page shows the
 *    banner, a third manual run within the minute → rate_limited;
 *  - get_logs kind "sync" lists the runs;
 *  - the module page: Run now, Pause and Resume; saving the config form
 *    keeps a pause (the form carries it without showing it).
 */

interface Created {
  app_id: string;
  slug: string;
}

interface Run {
  source: string;
  trigger: string;
  status: 'ok' | 'failed';
  records: number | null;
  error: string | null;
}

const SECRET = `sk-e2e-${randomBytes(12).toString('hex')}`;
const PLAYERS = { upstream: 'feed', path: '/sync/players?n=3', collection: 'players', items: 'data.players', every: '1h' };
const BROKEN = { ...PLAYERS, path: '/sync/fail' };

async function configure(mcp: McpClient, owner: BrowserContext, appId: string, module: string, config: unknown) {
  const r = await callTool(mcp.client, 'configure_module', { app_id: appId, module, config });
  expect(r.isError, JSON.stringify(r.json)).toBe(false);
  if (r.json.applied === false) {
    const ok = await owner.request.post(`${BASE_URL_WEB}/api/apps/${appId}/modules/${module}/confirm`, {
      headers: { Origin: BASE_URL_WEB },
      maxRedirects: 0,
    });
    expect(ok.status(), await ok.text()).toBe(200);
  }
  return r;
}

/** sync_now; a scheduled run of the same source holds its lease for a moment (busy / sync_running) — retried. */
async function syncNow(mcp: McpClient, appId: string, source: string) {
  for (let i = 0; ; i++) {
    const r = await callTool(mcp.client, 'sync_now', { app_id: appId, source });
    const details = r.json.details as { reason?: string } | undefined;
    if (!(r.isError && r.json.code === 'busy' && details?.reason === 'sync_running') || i >= 20) return r;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('platform module sync — scheduled imports from an upstream @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let ws: string;
  let app: Created;
  const answers: string[] = [];

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  test('an upstream, its assignment and a source each wait for the owner; skill_info documents the limits', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'sync-module', scope: FULL_SCOPE });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });
    ws = mcp.workspace;

    const form = await owner.newPage();
    await form.goto(`/workspaces/${ws}/upstreams`);
    await form.getByTestId('field-name').fill('feed');
    await form.getByTestId('field-baseurl').fill('http://proxy-echo');
    await form.getByTestId('field-methods').fill('GET');
    await form.getByTestId('field-paths').fill('/sync');
    await form.getByTestId('field-authtype').selectOption('bearer');
    await form.getByTestId('field-secret').fill(SECRET);
    await form.getByTestId('upstream-submit').click();
    await form.waitForURL(/\/upstreams$/);
    await expect(form.locator('[data-testid="upstream-row"][data-upstream-name="feed"]')).toBeVisible();
    await form.close();

    const info = await callTool(mcp.client, 'skill_info', { name: 'sync' });
    expect(info.isError, JSON.stringify(info.json)).toBe(false);
    expect(info.json).toMatchObject({ name: 'sync', kind: 'module' });
    expect(info.json.limits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'SYNC_PAUSE_AFTER_FAILURES' }),
        expect.objectContaining({ name: 'SYNC_NOW_PER_MINUTE' }),
      ])
    );

    app = (await callTool(mcp.client, 'create_app', { name: 'League table', template: 'react-ts' })).json as unknown as Created;
    await configure(mcp, owner, app.app_id, 'data', {
      collections: {
        players: {
          rules: { read: 'public' },
          schema: { type: 'object', required: ['name'], properties: { id: { type: 'number' }, name: { type: 'string' }, points: { type: 'number' } } },
        },
      },
    });
    await configure(mcp, owner, app.app_id, 'proxy', { upstreams: { feed: { rules: { call: 'none' } } } });
    const held = await callTool(mcp.client, 'configure_module', { app_id: app.app_id, module: 'sync', config: { sources: { players: PLAYERS } } });
    expect(held.isError, JSON.stringify(held.json)).toBe(false);
    expect(held.json.applied).toBe(false);
    expect(held.json.pending_confirmation).toEqual([
      'sync.sources.players: new scheduled import — every 1h GET the upstream "feed" at /sync/players?n=3 and replace every record of the collection "players"',
    ]);
    await configure(mcp, owner, app.app_id, 'sync', { sources: { players: PLAYERS } });
    answers.push(held.text, JSON.stringify(held.json));
  });

  test('sync_now writes the feed into the collection; the data API and query_data show it', async () => {
    skipUnlessLocal();
    const r = await syncNow(mcp, app.app_id, 'players');
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
    expect(r.json.run).toMatchObject({ source: 'players', trigger: 'manual', status: 'ok', records: 3 });
    answers.push(r.text, JSON.stringify(r.json));

    const pub = await hostRequest(previewHost(app.slug), '/__drobek/v1/data/players');
    expect(pub.status, pub.body).toBe(200);
    const names = (JSON.parse(pub.body) as { records: { name: string }[] }).records.map((p) => p.name).sort();
    expect(names).toEqual(['Ada', 'Bo', 'Cy']);

    const q = await callTool(mcp.client, 'query_data', { app_id: app.app_id, collection: 'players' });
    expect(q.json).toMatchObject({ total: 3 });
    const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    const sync = (got.json.modules as Record<string, { info?: { sources: Record<string, unknown>[] } }>).sync;
    expect(sync.info?.sources[0]).toMatchObject({ name: 'players', paused: null, last_status: 'ok' });
    answers.push(got.text, JSON.stringify(got.json));
  });

  test('a failing source pauses after 2 failed runs, the app page shows the banner, the 3rd run in a minute → rate_limited', async () => {
    skipUnlessLocal();
    await configure(mcp, owner, app.app_id, 'sync', { sources: { broken: BROKEN } });
    const first = await syncNow(mcp, app.app_id, 'broken');
    expect(first.isError, JSON.stringify(first.json)).toBe(false);
    expect(first.json.run).toMatchObject({ source: 'broken', status: 'failed', error: 'the upstream answered HTTP 500' });
    expect(String(first.json.note)).toBeTruthy();
    const second = await syncNow(mcp, app.app_id, 'broken');
    expect(second.json.run).toMatchObject({ status: 'failed' });
    answers.push(first.text, second.text);

    const third = await syncNow(mcp, app.app_id, 'broken');
    expect(third.isError).toBe(true);
    expect(third.json).toMatchObject({ code: 'rate_limited' });

    const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    const sources = (got.json.modules as Record<string, { info?: { sources: { name: string; paused: string | null }[] } }>).sync.info!.sources;
    expect(sources.find((s) => s.name === 'broken')?.paused).toBe('failures');

    // The records of the other source are untouched by the failures.
    const q = await callTool(mcp.client, 'query_data', { app_id: app.app_id, collection: 'players' });
    expect(q.json).toMatchObject({ total: 3 });

    const appPage = await owner.newPage();
    await appPage.goto(`/workspaces/${ws}/apps/${app.slug}`);
    const banner = appPage.getByTestId('sync-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('broken');
    await appPage.getByTestId('sync-banner-link').click();
    await appPage.waitForURL(/\/modules\/sync/);
    await expect(appPage.getByTestId('sync-source-broken')).toHaveAttribute('data-paused', 'failures');
    await appPage.close();
  });

  test('get_logs kind "sync" lists the runs inside the untrusted envelope', async () => {
    skipUnlessLocal();
    const logs = await callTool(mcp.client, 'get_logs', { app_id: app.app_id, kind: 'sync' });
    expect(logs.isError, JSON.stringify(logs.json)).toBe(false);
    expect(logs.text.startsWith('UNTRUSTED CONTENT:')).toBe(true);
    const entries = logs.json.entries as Run[];
    const manual = entries.filter((e) => e.trigger === 'manual').map((e) => [e.source, e.status]);
    expect(manual).toEqual([
      ['broken', 'failed'],
      ['broken', 'failed'],
      ['players', 'ok'],
    ]);
    answers.push(logs.text);
  });

  test('the module page: Resume clears the pause, Pause holds the schedule, Run now imports', async () => {
    skipUnlessLocal();
    const mod = await owner.newPage();
    await mod.goto(`/workspaces/${ws}/apps/${app.slug}/modules/sync`);
    await expect(mod.getByTestId('sync-runs')).toBeVisible();
    await expect(mod.getByTestId('module-heading')).toContainText('Scheduled imports (sync)');
    const form = mod.getByTestId('config-form');
    for (const [from, value] of [
      ['upstreams', 'feed'],
      ['collections', 'players'],
      ['intervals', '1h'],
    ] as const) {
      await expect(form.locator(`select[data-choices="${from}"]`).first()).toHaveValue(value);
    }

    await mod.getByTestId('sync-resume-broken').click();
    await expect(mod.getByTestId('sync-source-broken')).toHaveAttribute('data-paused', '');

    await mod.getByTestId('sync-pause-players').click();
    await expect(mod.getByTestId('sync-source-players')).toHaveAttribute('data-paused', 'owner');
    // The form shows no Paused checkbox but carries the pause through a save.
    await expect(form.locator('input[type="checkbox"][name$=".paused"]')).toHaveCount(0);
    await expect(form.locator('input[type="hidden"][name$=".paused"][value="true"]')).toHaveCount(1);
    await mod.getByTestId('config-save').click();
    await expect(mod.getByTestId('done-notice')).toHaveAttribute('data-done', 'unchanged');
    await expect(mod.getByTestId('sync-source-players')).toHaveAttribute('data-paused', 'owner');
    await mod.getByTestId('sync-run-players').click();
    await expect(mod.getByTestId('sync-source-players')).toHaveAttribute('data-status', 'ok');
    await mod.getByTestId('sync-resume-players').click();
    await expect(mod.getByTestId('sync-source-players')).toHaveAttribute('data-paused', '');
    expect(await mod.content()).not.toContain(SECRET);
    await mod.close();

    const app2 = await owner.newPage();
    await app2.goto(`/workspaces/${ws}/apps/${app.slug}`);
    await expect(app2.getByRole('heading').first()).toBeVisible();
    await expect(app2.getByTestId('sync-banner')).toHaveCount(0);
    await app2.close();
  });

  test('the secret never appears in a tool answer', () => {
    skipUnlessLocal();
    expect(answers.length).toBeGreaterThan(0);
    for (const a of answers) expect(a).not.toContain(SECRET);
  });
});
