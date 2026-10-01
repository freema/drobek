import { expect, test } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';

/**
 * Where an agent puts scheduled work. With the `sync` module active, the
 * app briefing (create_app and get_app) sends a cron or a periodic refresh
 * of external data to `sync` — `skill_info('sync')` — and says why there
 * are no cron scripts: the server never runs app code. skill_info lists sync
 * for crons, and its skill says the same.
 */

const RULE = [
  'Work on a schedule (a cron, a periodic refresh of data from an external API: scores, prices, fixtures, a feed) is the `sync` module',
  "call `skill_info('sync')`",
  'The server never runs app code, so there are no cron scripts of your own',
  'a sync source fetches JSON from a proxy upstream on an interval into a `data` collection the app reads with `drobek.data`',
  'any computation on that data happens in the browser',
];

test('the briefing of create_app and get_app leads scheduled work to sync; the server never runs app code @local', async ({ page, request }) => {
  skipUnlessLocal();
  const mcp = await mcpClient(page, request, { tag: 'briefing-sync' });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Scores Board E2E' });
    expect(created.isError, created.text).toBe(false);
    const fromCreate = String(created.json.briefing);
    for (const phrase of RULE) expect(fromCreate).toContain(phrase);
    expect(fromCreate).toMatch(/^ {2}- `sync` — use when data from an external API should refresh on its own — a cron/m);

    const got = await callTool(mcp.client, 'get_app', { app_id: created.json.app_id });
    expect(got.isError, got.text).toBe(false);
    const fromGet = String(got.json.briefing);
    for (const phrase of RULE) expect(fromGet).toContain(phrase);

    const list = await callTool(mcp.client, 'skill_info', {});
    expect(list.isError, list.text).toBe(false);
    const sync = (list.json.skills as { name: string; use_when: string }[]).find((s) => s.name === 'sync');
    expect(sync?.use_when).toContain('a cron or periodic update of scores, prices, a feed');

    const info = await callTool(mcp.client, 'skill_info', { name: 'sync' });
    expect(info.isError, info.text).toBe(false);
    const content = String(info.json.content);
    expect(content).toContain('a cron job, a scheduled task or a periodic update');
    expect(content).toContain('No app code runs on the');
    expect(content).toContain('there are no cron scripts');
  } finally {
    await mcp.client.close();
  }
});
