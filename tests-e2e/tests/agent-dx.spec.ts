import { expect, test } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, mcpClient } from './helpers/mcp';

/**
 * The agent-facing docs are served and in sync with the real tools: /llms.txt
 * + /llms-full.txt render from the @drobek/agent-dx manifest, the same content
 * is reachable over MCP as docs resources + prompts, and the build page carries
 * the install command + MCP URL.
 */

/** Exactly the MCP tool set; set_workspace_publishing, set_workspace_module, takedown_app, restore_app and set_gallery_hidden are a super-admin's only. */
const ALL_TOOLS = [
  'list_apps',
  'create_app',
  'duplicate_app',
  'get_app',
  'read_file',
  'write_files',
  'restore_version',
  'publish',
  'set_gallery_listing',
  'unpublish',
  'set_visibility',
  'set_frame_ancestors',
  'release_lease',
  'delete_app',
  'skill_info',
  'configure_module',
  'query_data',
  'create_records',
  'update_record',
  'delete_record',
  'delete_collection',
  'purge_orphan_records',
  'get_logs',
  'sync_now',
  'create_asset_upload',
  'list_assets',
  'delete_asset',
  'list_form_submissions',
  'delete_form_submission',
  'list_end_users',
  'set_end_user_role',
  'set_end_user_blocked',
  'sign_out_end_users',
  'list_uploads',
  'delete_upload',
  'remove_module_secret',
  'list_activity',
  'list_domains',
  'add_domain',
  'verify_domain',
  'set_primary_domain',
  'remove_domain',
  'list_upstreams',
  'register_upstream',
  'remove_upstream',
  'create_workspace',
  'list_members',
  'invite_member',
  'set_member_role',
  'remove_member',
  'delete_workspace',
];

/** Retired tools — never advertised. */
const REMOVED_TOOLS = [
  'deploy_init', // doc-lint: allow — retired tool, asserted absent
  'deploy_commit', // doc-lint: allow — retired tool, asserted absent
  'deploy_status',
  'whoami',
  'collection_define',
  'record_create',
  'record_query',
  'app_errors',
  'app_logs',
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
  expect(body).toContain('https://github.com/freema/drobek/blob/main/docs/AGENT.md');
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

  // No REST data API / upload routes.
  // doc-lint: allow — retired path, asserted absent
  expect(body).not.toContain('/:ws/app/:slug');
  expect(body).not.toContain('__upload');
  expect(body).not.toContain('__beacon');

  // The briefing (stack, import map, rules) and the annotations.
  expect(body).toContain('## The app briefing');
  expect(body).toContain('https://esm.sh/react@');
  expect(body).toContain('destructiveHint=true');

  // Error catalogue.
  expect(body).toContain('## Error catalogue');
  expect(body).toContain('app_locked');
  expect(body).toContain('secret_in_source');
  expect(body).toContain('redirect_uri');
  // …then one section per active module with its own codes.
  expect(body).toContain('### Module auth');
  expect(body).toContain('- invalid_code — module route (auth) — ');
  expect(body).toContain('### Module proxy');
  expect(body).toContain('- upstream_error — module route (proxy) — ');
  expect(body).toContain('- upstream_redirect — module route (proxy) — ');

  // Limits: the compile caps + the tool contract limits.
  expect(body).toContain('COMPILE_MAX_FILES');
  expect(body).toContain('COMPILE_MAX_FILE_BYTES');
  expect(body).toContain('COMPILE_MAX_TOTAL_BYTES');
  expect(body).not.toContain('DEPLOY_MAX_');
});

test('build-with-your-agent page renders with the plugin + skill install commands + MCP URL @local', async ({
  request,
}) => {
  skipUnlessLocal();
  const res = await request.get(`${BASE_URL_WEB}/build-with-your-agent`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('cp -r skills/drobek ~/.claude/skills/drobek');
  expect(html).toContain('claude plugin marketplace add freema/drobek-plugin');
  expect(html).toContain('claude plugin install drobek@drobek');
  expect(html).toContain('/drobek:build-app');
  expect(html).toContain('https://github.com/freema/drobek-plugin');
  expect(html).toContain('/mcp');
  // The tool list is rendered on the page — the current tools, no removed ones.
  for (const name of ALL_TOOLS) expect(html, name).toContain(name);
  for (const name of REMOVED_TOOLS) expect(html, name).not.toContain(name);
});

test('MCP tools/list is exactly the documented tools; docs resources + the build-an-app prompt are populated @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  // Every scope → tools/list is exactly the documented tools.
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
    expect(text).toContain('# drobek — full agent contract');
    for (const name of ALL_TOOLS) expect(text, name).toContain(name);
    for (const name of REMOVED_TOOLS) expect(text, name).not.toContain(name);
    expect(text).toContain('## Error catalogue');

    // prompts/list → the single guided prompt.
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['build-an-app']);

    // prompts/get → a populated message carrying the passed arguments.
    const got = await client.getPrompt({
      name: 'build-an-app',
      arguments: { name: 'Shift planner', idea: 'plan weekly shifts', workspace: 'acme' },
    });
    expect(got.messages.length).toBeGreaterThan(0);
    const msg = got.messages[0].content as { type: string; text?: string };
    expect(msg.type).toBe('text');
    expect(msg.text ?? '').toContain('create_app({ name: "Shift planner", workspace: "acme" })');
    expect(msg.text ?? '').toContain('write_files');
    expect(msg.text ?? '').toContain('preview_url');
  } finally {
    await transport.close();
  }
});
