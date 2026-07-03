import { expect, test } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { skipUnlessLocal } from './helpers/auth';
import { mcpClient } from './helpers/deploy';

/**
 * M1b Agent DX acceptance (PHY-124): the agent-facing docs are served + in sync
 * with the real tools. /llms.txt + /llms-full.txt render from the @drobek/agent-dx
 * manifest; the same content is reachable over MCP as docs resources + guided
 * prompts; and the human build page carries the install command + MCP URL.
 *
 * The "fresh agent builds a todo app from the skill" acceptance is a MANUAL
 * operator demo — here we assert the INGREDIENTS.
 */

const ALL_TOOLS = [
  'whoami',
  'list_apps',
  'deploy_init',
  'deploy_commit',
  'deploy_status',
  'rollback',
  'collection_define',
  'record_create',
  'record_read',
  'record_update',
  'record_delete',
  'record_query',
];

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

test('GET /llms-full.txt → 200 with every tool, the REST shapes, and the error catalogue @local', async ({
  request,
}) => {
  skipUnlessLocal();
  const res = await request.get(`${BASE_URL_WEB}/llms-full.txt`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/plain');
  const body = await res.text();

  for (const name of ALL_TOOLS) expect(body, name).toContain(name);

  // REST data API shapes + access modes.
  expect(body).toContain('/:ws/app/:slug/data/:collection');
  expect(body).toContain('/:ws/app/:slug/data/:collection/:id');
  expect(body).toContain('public-write');
  expect(body).toContain('locked');

  // Error catalogue.
  expect(body).toContain('## Error catalogue');
  expect(body).toContain('validation_failed');
  expect(body).toContain('too_many_docs');
  expect(body).toContain('redirect_uri');

  // Limits.
  expect(body).toContain('DATA_MAX_DOCS_PER_APP');
  expect(body).toContain('DEPLOY_MAX_FILE_BYTES');
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
  // The tool list is rendered on the page.
  expect(html).toContain('deploy_init');
});

test('MCP docs resources + guided prompts are discoverable and populated @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  // Docs resources/prompts are scope-agnostic — the read/whoami baseline suffices.
  const { client, transport } = await mcpClient(page, request, {
    tag: 'agent-dx',
    scope: 'mcp:whoami apps:read',
  });
  try {
    // resources/list → the docs resource(s).
    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    expect(uris).toContain('drobek://docs/llms-full');

    // resources/read → the llms-full content.
    const read = await client.readResource({ uri: 'drobek://docs/llms-full' });
    const text = (read.contents[0] as { text?: string }).text ?? '';
    expect(text).toContain('# drobek — full delivery-stack contract');
    for (const name of ALL_TOOLS) expect(text, name).toContain(name);
    expect(text).toContain('## Error catalogue');

    // prompts/list → the 2 guided prompts.
    const prompts = await client.listPrompts();
    const promptNames = prompts.prompts.map((p) => p.name);
    expect(promptNames).toContain('deploy-this-project');
    expect(promptNames).toContain('add-data-to-app');

    // prompts/get → a populated message.
    const got = await client.getPrompt({
      name: 'deploy-this-project',
      arguments: {},
    });
    expect(got.messages.length).toBeGreaterThan(0);
    const msg = got.messages[0].content as { type: string; text?: string };
    expect(msg.type).toBe('text');
    expect(msg.text ?? '').toContain('deploy_init');
  } finally {
    await transport.close();
  }
});
