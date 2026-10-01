import { expect, test } from '@playwright/test';
import { hostRequest, previewHost, prodHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';

/**
 * How an app shows up outside its own page, over MCP. drobek adds nothing to
 * an app's <head>; the publish readiness report of every write names what is
 * missing, never refusing the write:
 *  - `missing_description`: index.html has no <meta name="description">;
 *  - `missing_favicon`: no <link rel="icon"> and no favicon.ico — the
 *    browser's own /favicon.ico request is a 404;
 *  - `og_image_not_absolute`: a link-preview image that is not an absolute
 *    https URL.
 * A description, an SVG favicon written with write_files and an absolute
 * og:image clear all three.
 */

interface Finding {
  code: string;
  file?: string;
  line?: number;
  message: string;
  hint: string;
}

function readinessOf(json: Record<string, unknown>): { ready: boolean; blocking: unknown[]; warnings: Finding[] } {
  return json.readiness as { ready: boolean; blocking: unknown[]; warnings: Finding[] };
}

const BARE = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <title>Head E2E</title>',
  '    <meta property="og:image" content="/og.png" />',
  '  </head>',
  '  <body>',
  '    <h1>Head E2E</h1>',
  '  </body>',
  '</html>',
  '',
].join('\n');

const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0f766e"/></svg>\n';

const described = (slug: string): string =>
  BARE.replace(
    '    <meta property="og:image" content="/og.png" />',
    [
      '    <meta name="description" content="Checks the head of a drobek app end to end." />',
      '    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
      '    <meta property="og:title" content="Head E2E" />',
      '    <meta property="og:description" content="Checks the head of a drobek app end to end." />',
      '    <meta property="og:type" content="website" />',
      `    <meta property="og:url" content="https://${prodHost(slug)}/" />`,
      `    <meta property="og:image" content="https://${prodHost(slug)}/og.png" />`,
      '    <meta name="twitter:card" content="summary_large_image" />',
    ].join('\n')
  );

test('readiness names a missing description, a missing favicon and a relative og:image, and clears them once added @local', async ({ page, request }) => {
  skipUnlessLocal();
  const mcp = await mcpClient(page, request, { tag: 'readiness-head' });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Readiness Head E2E', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;

    const bare = await callTool(mcp.client, 'write_files', {
      app_id: appId,
      files: [{ path: 'index.html', content: BARE }],
      reasoning: 'A page without a description or an icon',
    });
    expect(bare.isError, bare.text).toBe(false);
    expect(bare.json).toMatchObject({ version: 2, compile: { ok: true, errors: [] } });
    const before = readinessOf(bare.json);
    expect(before.ready).toBe(true);
    expect(before.blocking).toEqual([]);
    expect(before.warnings.map((w) => `${w.code} ${w.file}:${w.line}`), JSON.stringify(before.warnings)).toEqual([
      'missing_description index.html:3',
      'missing_favicon index.html:3',
      'og_image_not_absolute index.html:6',
    ]);
    const [description, favicon, ogImage] = before.warnings;
    expect(description.message).toContain('index.html has no <meta name="description">');
    expect(description.hint).toContain('<meta name="description" content="One sentence: what the app does.">');
    expect(favicon.message).toContain('the browser\'s request for /favicon.ico gets a 404');
    expect(favicon.message).toContain('An uploaded favicon.ico counts only when index.html links it');
    expect(favicon.hint).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(ogImage.message).toContain('<meta property="og:image"> is "/og.png", not an absolute https:// URL');
    expect(ogImage.hint).toContain('create_asset_upload');

    // drobek adds nothing to the page: no icon of its own, so /favicon.ico is a 404; the preview is noindex.
    const preview = await hostRequest(previewHost(slug), '/');
    expect(preview.status).toBe(200);
    expect(preview.body).toContain('<title>Head E2E</title>');
    expect(preview.body).not.toContain('rel="icon"');
    expect(preview.body).not.toContain('name="description"');
    expect(preview.headers['x-robots-tag']).toBe('noindex');
    expect((await hostRequest(previewHost(slug), '/favicon.ico')).status).toBe(404);

    const fixed = await callTool(mcp.client, 'write_files', {
      app_id: appId,
      files: [
        { path: 'index.html', content: described(slug) },
        { path: 'favicon.svg', content: FAVICON_SVG },
      ],
      reasoning: 'A description, an SVG favicon and link-preview tags',
    });
    expect(fixed.isError, fixed.text).toBe(false);
    expect(fixed.json).toMatchObject({ version: 3, compile: { ok: true, errors: [], warnings: [] } });
    expect(fixed.json.readiness).toEqual({ ready: true, blocking: [], warnings: [] });

    const icon = await hostRequest(previewHost(slug), '/favicon.svg');
    expect(icon.status).toBe(200);
    expect(icon.headers['content-type']).toMatch(/^image\/svg\+xml/);
  } finally {
    await mcp.client.close();
  }
});
