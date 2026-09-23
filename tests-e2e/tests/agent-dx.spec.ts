import { expect, test } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, mcpClient } from './helpers/mcp';

/**
 * M1b Agent DX acceptance (PHY-124): the agent-facing docs are served + in sync
 * with the real tools. /llms.txt + /llms-full.txt render from the @drobek/agent-dx
 * manifest; the same content is reachable over MCP as docs resources + guided
 * prompts; and the human build page carries the install command + MCP URL.
 *
 * The "fresh agent builds a todo app from the skill" acceptance is a MANUAL
 * operator demo — here we assert the INGREDIENTS.
 */

/** Exactly the MCP tools that exist after the deploy pipeline removal (NSO-281). */
const ALL_TOOLS = [
  'whoami',
  'list_apps',
  'collection_define',
  'record_create',
  'record_read',
  'record_update',
  'record_delete',
  'record_query',
  'app_errors',
  'app_logs',
];

/** Removed with the upload/deploy pipeline — must not be advertised anywhere. */
const REMOVED_TOOLS = ['deploy_init', 'deploy_commit', 'deploy_status', 'rollback'];

test('GET /llms.txt → 200 text/plain with the title + section links @smoke', async ({
  request,
}) => {
  const res = await request.get(`${BASE_URL_WEB}/llms.txt`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/plain');
  const body = await res.text();
  expect(body.startsWith('# drobek')).toBe(true);
  expect(body).toContain('## Docs');
  expect(body).toContain('/llms-full.txt');
  expect(body).toContain('/build-with-your-agent');
});

test('GET /llms-full.txt → 200 with every tool, no deploy pipeline, the limits, and the error catalogue @local', async ({
  request,
}) => {
  skipUnlessLocal();
  const res = await request.get(`${BASE_URL_WEB}/llms-full.txt`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/plain');
  const body = await res.text();

  for (const name of ALL_TOOLS) expect(body, name).toContain(`### ${name} `);
  for (const name of REMOVED_TOOLS) expect(body, name).not.toContain(name);

  // app_logs documents the version-based shape, not the old deploy list.
  expect(body).toContain('recentVersions');
  expect(body).not.toContain('recentDeploys');

  // No REST data API / upload routes any more — data goes through the MCP tools.
  expect(body).not.toContain('/:ws/app/:slug');
  expect(body).not.toContain('__upload');
  expect(body).not.toContain('__beacon');

  // Data access modes are still documented (they gate the MCP data tools).
  expect(body).toContain('public-write');
  expect(body).toContain('locked');

  // Error catalogue.
  expect(body).toContain('## Error catalogue');
  expect(body).toContain('validation_failed');
  expect(body).toContain('too_many_docs');
  expect(body).toContain('redirect_uri');

  // Limits: data caps + the compile caps that replaced DEPLOY_MAX_*.
  expect(body).toContain('DATA_MAX_DOCS_PER_APP');
  expect(body).toContain('COMPILE_MAX_FILES');
  expect(body).toContain('COMPILE_MAX_FILE_BYTES');
  expect(body).toContain('COMPILE_MAX_TOTAL_BYTES');
  expect(body).not.toContain('DEPLOY_MAX_');
});

test('build-with-your-agent page renders with the skill install command + MCP URL @local', async ({
  request,
}) => {
  skipUnlessLocal();
  const res = await request.get(`${BASE_URL_WEB}/build-with-your-agent`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('cp -r skills/drobek ~/.claude/skills/drobek');
  expect(html).toContain('/mcp');
  // The tool list is rendered on the page — the current tools, no deploy tools.
  expect(html).toContain('collection_define');
  expect(html).toContain('app_logs');
  for (const name of REMOVED_TOOLS) expect(html, name).not.toContain(name);
});

test('MCP tools/list is exactly the 10 tools; docs resources + the add-data prompt are populated @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  // Every scope → tools/list is exactly the 10 remaining tools.
  const { client, transport } = await mcpClient(page, request, {
    tag: 'agent-dx',
    scope: FULL_SCOPE,
  });
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect([...tools].sort()).toEqual([...ALL_TOOLS].sort());

    // resources/list → the docs resource(s).
    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    expect(uris).toContain('drobek://docs/llms-full');

    // resources/read → the llms-full content.
    const read = await client.readResource({ uri: 'drobek://docs/llms-full' });
    const text = (read.contents[0] as { text?: string }).text ?? '';
    expect(text).toContain('# drobek — full delivery-stack contract');
    for (const name of ALL_TOOLS) expect(text, name).toContain(name);
    for (const name of REMOVED_TOOLS) expect(text, name).not.toContain(name);
    expect(text).toContain('## Error catalogue');

    // prompts/list → the single remaining guided prompt.
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['add-data-to-app']);

    // prompts/get → a populated message carrying the passed locator.
    const got = await client.getPrompt({
      name: 'add-data-to-app',
      arguments: { workspace: 'acme', slug: 'my-todo', collection: 'todos' },
    });
    expect(got.messages.length).toBeGreaterThan(0);
    const msg = got.messages[0].content as { type: string; text?: string };
    expect(msg.type).toBe('text');
    expect(msg.text ?? '').toContain('collection_define');
    expect(msg.text ?? '').toContain('acme/my-todo');
    expect(msg.text ?? '').toContain('"todos"');
  } finally {
    await transport.close();
  }
});
