import { expect, test } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';

/**
 * The HTML and accessibility basics, over MCP. The publish readiness report
 * of every write names what the `.html` files of the version miss, never
 * refusing the write:
 *  - `html_missing_lang` / `html_missing_viewport`: a full document without
 *    a lang on <html> or a viewport meta;
 *  - `a11y_img_alt`: an <img> without alt;
 *  - `a11y_name`: a button or a link without an accessible name;
 *  - `a11y_label`: a form field without a label.
 * A fragment (no <html>, no <head>) gets the element rules only. A lang, a
 * viewport, an alt, an aria-label and a <label> clear all of them.
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

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

const BARE = [
  '<!doctype html>',
  '<html>',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <title>Basics E2E</title>',
  '    <meta name="description" content="Checks the HTML and accessibility basics end to end." />',
  '    <link rel="icon" href="data:," />',
  '  </head>',
  '  <body>',
  `    <img src="${PIXEL}" />`,
  '    <button id="menu"><svg viewBox="0 0 8 8"><path d="M0 1h8M0 4h8M0 7h8" /></svg></button>',
  '    <input type="search" name="q" placeholder="Search" />',
  '  </body>',
  '</html>',
  '',
].join('\n');

const BARE_CARD = ['<article class="card">', `  <img src="${PIXEL}" />`, '  <h2>Card</h2>', '</article>', ''].join('\n');

const FIXED = BARE.replace('<html>', '<html lang="en">')
  .replace('    <title>', '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>')
  .replace(`<img src="${PIXEL}" />`, `<img src="${PIXEL}" alt="A single pixel" />`)
  .replace('<button id="menu">', '<button id="menu" aria-label="Menu">')
  .replace('<input type="search" name="q" placeholder="Search" />', '<label>Search <input type="search" name="q" /></label>');

const FIXED_CARD = BARE_CARD.replace(`<img src="${PIXEL}" />`, `<img src="${PIXEL}" alt="" />`);

test('readiness names a page without lang or viewport, an image without alt, an unnamed button and an unlabelled field, and clears them once fixed @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const mcp = await mcpClient(page, request, { tag: 'readiness-basics' });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Readiness Basics E2E', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;

    const bare = await callTool(mcp.client, 'write_files', {
      app_id: appId,
      files: [
        { path: 'index.html', content: BARE },
        { path: 'partials/card.html', content: BARE_CARD },
      ],
      reasoning: 'A page and a fragment without the HTML and accessibility basics',
    });
    expect(bare.isError, bare.text).toBe(false);
    expect(bare.json).toMatchObject({ version: 2, compile: { ok: true, errors: [], warnings: [] } });
    const before = readinessOf(bare.json);
    expect(before.ready).toBe(true);
    expect(before.blocking).toEqual([]);
    expect(before.warnings.map((w) => `${w.code} ${w.file}:${w.line}`), JSON.stringify(before.warnings)).toEqual([
      'html_missing_lang index.html:2',
      'html_missing_viewport index.html:3',
      'a11y_img_alt index.html:10',
      'a11y_name index.html:11',
      'a11y_label index.html:12',
      'a11y_img_alt partials/card.html:2',
    ]);
    const [lang, viewport, alt, name, label] = before.warnings;
    expect(lang.message).toContain('index.html has no lang on its <html> element');
    expect(lang.hint).toContain('<html lang="en">');
    expect(viewport.message).toContain('index.html has no <meta name="viewport">');
    expect(viewport.hint).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(alt.message).toContain('has no alt attribute');
    expect(alt.hint).toContain('alt=""');
    expect(name.message).toContain('<button id="menu"> has no accessible name');
    expect(name.hint).toContain('aria-label');
    expect(label.message).toContain('<input type="search" name="q"> has no label');
    expect(label.hint).toContain('<label for="email">');

    const fixed = await callTool(mcp.client, 'write_files', {
      app_id: appId,
      files: [
        { path: 'index.html', content: FIXED },
        { path: 'partials/card.html', content: FIXED_CARD },
      ],
      reasoning: 'A lang, a viewport, an alt, an aria-label and a label',
    });
    expect(fixed.isError, fixed.text).toBe(false);
    expect(fixed.json).toMatchObject({ version: 3, compile: { ok: true, errors: [], warnings: [] } });
    expect(fixed.json.readiness).toEqual({ ready: true, blocking: [], warnings: [] });
  } finally {
    await mcp.client.close();
  }
});
