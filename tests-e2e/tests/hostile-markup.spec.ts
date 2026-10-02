import { expect, test } from '@playwright/test';
import { hostRequest, prodHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * Malformed markup costs what well-formed markup does. A version whose files
 * are each 512 KiB (the per-file limit) of unclosed tags, attributes and
 * comments, an unterminated CSS `url(` or a script of short string literals
 * is scanned in seconds:
 *  - write_files stores and compiles it with its reference warnings and its
 *    readiness report, and the instance keeps answering;
 *  - publish puts it live, and the publish heuristic still reads the
 *    password field and the brand word of index.html and files its report.
 * The pattern scans these steps ran before took minutes on such a file, on
 * the one Node process, so no request of any workspace was answered
 * meanwhile, and the heuristic gave up on the script.
 */

const SIZE = 512 * 1024;
const fill = (unit: string, head = ''): string => (head + unit.repeat(Math.ceil(SIZE / unit.length))).slice(0, SIZE);
const BUDGET_MS = 15_000;

async function timed<T>(f: () => Promise<T>): Promise<[T, number]> {
  const started = Date.now();
  const out = await f();
  return [out, Date.now() - started];
}

async function heuristicReportsOf(appId: string): Promise<{ details: string }[]> {
  return withDb(async (c) =>
    (await c.query(`SELECT details FROM abuse_reports WHERE app_id = $1 AND reason = 'heuristic' ORDER BY created_at`, [appId])).rows
  );
}

test('a version of hostile HTML and CSS at the per-file limit is written, checked and published in seconds @local', async ({ page, request }) => {
  skipUnlessLocal();
  test.setTimeout(120_000);
  const mcp = await mcpClient(page, request, { tag: 'hostile-markup' });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Hostile Markup E2E', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;

    const files = [
      { path: 'index.html', content: fill('<a x=y ', '<!doctype html><title>Bank login</title><input name="pin" type="password">\n') },
      { path: 'tags.html', content: fill('<a ') },
      { path: 'quotes.html', content: fill('<a x="') },
      { path: 'comments.html', content: fill('<!--') },
      { path: 'strings.js', content: fill('"a";') },
      { path: 'styles.css', content: fill('url(') },
      { path: 'comments.css', content: fill('/* ') },
    ];
    const [written, writeMs] = await timed(() => callTool(mcp.client, 'write_files', { app_id: appId, files, reasoning: 'Hostile markup' }));
    expect(written.isError, written.text.slice(0, 500)).toBe(false);
    expect(written.json).toMatchObject({ version: 2, compile: { ok: true, errors: [] } });
    expect((written.json.readiness as { blocking: unknown[] }).blocking).toEqual([]);
    expect(writeMs, 'write_files compiles and checks the version').toBeLessThan(BUDGET_MS);

    const [health, healthMs] = await timed(() => request.get('/healthz'));
    expect(health.status()).toBe(200);
    expect(healthMs).toBeLessThan(5_000);

    const [published, publishMs] = await timed(() => callTool(mcp.client, 'publish', { app_id: appId }));
    expect(published.isError, published.text.slice(0, 500)).toBe(false);
    expect(publishMs, 'publish runs the readiness report and the heuristic').toBeLessThan(BUDGET_MS);
    expect((await hostRequest(prodHost(slug), '/tags.html')).status).toBe(200);

    const reports = await heuristicReportsOf(appId);
    expect(reports, 'the heuristic read index.html next to the 512 KiB script').toHaveLength(1);
    expect(reports[0].details).toMatch(/password field \(index\.html\).*"bank" \(title\)/);
  } finally {
    await mcp.client.close();
  }
});
