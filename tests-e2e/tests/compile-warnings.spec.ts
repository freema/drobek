import { expect, test } from '@playwright/test';
import { previewHost, hostRequest } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';

/**
 * Compile warnings over MCP: every write is scanned for references the
 * browser cannot load, and the result says so in `compile.warnings` — never
 * refusing the write.
 *  - `missing_reference`: a local path no file of the version has (the
 *    browser gets a 404), with the file and line of the reference;
 *  - `blocked_by_csp`: an external URL the app CSP blocks, naming the
 *    directive, what it allows and the fix (a proxy upstream for fetch, the
 *    https:// URL for http);
 *  - nothing for what cannot be checked or is fine: computed URLs, data:
 *    URIs, #anchors, the build outputs main.js/main.css, https://esm.sh.
 */

interface Warning {
  code: string;
  file: string | null;
  line: number | null;
  text: string;
}

const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <title>Warnings</title>',
  '    <link rel="icon" href="/favicon.ico" />',
  '    <link rel="stylesheet" href="/main.css" />',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '    <a href="#top">Top</a>',
  '    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" />',
  '    <img src="http://images.example.com/cat.png" alt="" />',
  '    <script type="module" src="/main.js"></script>',
  '  </body>',
  '</html>',
  '',
].join('\n');

const MAIN_TSX = [
  "import { createRoot } from 'react-dom/client';",
  "import './styles.css';",
  '',
  "const id = new URLSearchParams(location.search).get('id') ?? 'a';",
  'void fetch(`/api/${id}.json`);',
  "void fetch('/data/' + id + '.json');",
  "void fetch('https://esm.sh/robots.txt');",
  "void fetch('https://api.example.com/x').then((r) => r.json());",
  '',
  "createRoot(document.getElementById('root')!).render(<main>Warnings</main>);",
  '',
].join('\n');

const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>\n';

function warningsOf(json: Record<string, unknown>): Warning[] {
  return (json.compile as { warnings: Warning[] }).warnings;
}

test('write_files stores a version with broken references and lists them as compile warnings @local', async ({ page, request }) => {
  skipUnlessLocal();
  const mcp = await mcpClient(page, request, { tag: 'compile-warn' });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Compile Warnings E2E' });
    expect(created.isError, created.text).toBe(false);
    expect(created.json.compile).toMatchObject({ ok: true, errors: [], warnings: [] });
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;

    const html = await callTool(mcp.client, 'create_app', { name: 'Compile Warnings HTML E2E', template: 'html' });
    expect(html.isError, html.text).toBe(false);
    expect(html.json.compile).toMatchObject({ ok: true, errors: [], warnings: [] });

    const w = await callTool(mcp.client, 'write_files', {
      app_id: appId,
      files: [
        { path: 'index.html', content: INDEX_HTML },
        { path: 'src/main.tsx', content: MAIN_TSX },
      ],
      reasoning: 'A favicon, an external image and an API call',
    });
    expect(w.isError, w.text).toBe(false);
    expect(w.json).toMatchObject({ version: 2, compile: { ok: true, errors: [] } });
    const warnings = warningsOf(w.json);
    expect(warnings.map((x) => x.code).sort(), JSON.stringify(warnings)).toEqual(['blocked_by_csp', 'blocked_by_csp', 'missing_reference']);

    const missing = warnings.find((x) => x.code === 'missing_reference') as Warning;
    expect(missing).toMatchObject({ file: 'index.html', line: 6 });
    expect(missing.text).toContain('"/favicon.ico" points to favicon.ico, which this version does not have: the browser gets a 404.');
    expect(missing.text).toContain('create_asset_upload');

    const api = warnings.find((x) => x.code === 'blocked_by_csp' && x.file === 'src/main.tsx') as Warning;
    expect(api, JSON.stringify(warnings)).toBeTruthy();
    expect(api.line).toBe(8);
    expect(api.text).toContain('"https://api.example.com/x" is blocked by the app CSP: connect-src allows only \'self\' https://esm.sh.');
    expect(api.text).toContain("proxy upstream of the proxy module (skill_info('proxy'))");

    const image = warnings.find((x) => x.code === 'blocked_by_csp' && x.file === 'index.html') as Warning;
    expect(image, JSON.stringify(warnings)).toBeTruthy();
    expect(image.line).toBe(13);
    expect(image.text).toContain('"http://images.example.com/cat.png" is blocked by the app CSP: img-src allows only');
    expect(image.text).toContain('Use the https:// URL');

    // Nothing was refused: the version is the preview, the missing file is a 404 there.
    const preview = await hostRequest(previewHost(slug), '/');
    expect(preview.status).toBe(200);
    expect(preview.body).toContain('href="/favicon.ico"');
    expect((await hostRequest(previewHost(slug), '/favicon.ico')).status).toBe(404);

    // Pointing the icon at a file the next version has clears that warning only.
    const fixed = await callTool(mcp.client, 'write_files', {
      app_id: appId,
      files: [
        { path: 'index.html', content: INDEX_HTML.replace('href="/favicon.ico"', 'href="/favicon.svg"') },
        { path: 'favicon.svg', content: FAVICON_SVG },
      ],
      reasoning: 'Add the favicon',
    });
    expect(fixed.isError, fixed.text).toBe(false);
    expect(fixed.json).toMatchObject({ version: 3, compile: { ok: true, errors: [] } });
    expect(warningsOf(fixed.json).map((x) => `${x.code} ${x.file}`).sort()).toEqual(['blocked_by_csp index.html', 'blocked_by_csp src/main.tsx']);
    expect((await hostRequest(previewHost(slug), '/favicon.svg')).status).toBe(200);
  } finally {
    await mcp.client.close();
  }
});
