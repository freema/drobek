/**
 * The agent-docs renderers (M1b Agent DX, PHY-124) — PURE, react-free string
 * builders the web routes (/llms.txt, /llms-full.txt, /build-with-your-agent)
 * and the MCP docs resources render from, so every surface stays in sync with
 * the TOOL_DOCS manifest, the error catalogue, and the limits.
 */
import { renderBriefing } from './briefing.js';
import { ERROR_CATALOGUE } from './errors-catalogue.js';
import { LIMITS } from './limits.js';
import {
  PLUGIN_BUILD_COMMAND,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_MARKETPLACE_ADD_COMMAND,
  PLUGIN_MCP_URL,
  PLUGIN_REPO_URL,
} from './plugin.js';
import { TOOL_DOCS, type ToolDoc } from './tools.js';
import {
  mcpEndpoint,
  protectedResourceMetadataUrl,
  publicAppUrl,
} from './urls.js';

/** The one-command skill install (self-host repo → Claude Code skills dir). */
export const SKILL_INSTALL_COMMAND = 'cp -r skills/drobek ~/.claude/skills/drobek';

/**
 * The agent guide in the source repository (NSO-298): the tools with their
 * scopes, the briefing, the skills and these surfaces, in one document.
 * Linked from /llms.txt.
 */
export const AGENT_GUIDE_URL = 'https://github.com/freema/drobek/blob/main/docs/AGENT.md';

/** MCP docs resource URIs (stable — referenced by agents + tests). */
export const DOCS_RESOURCE_LLMS_FULL = 'drobek://docs/llms-full';
export const DOCS_RESOURCE_TOOLS = 'drobek://docs/tools';

const SUMMARY =
  'drobek is an open-source cloud workspace for agent-built web apps. Connect the drobek MCP server from your agent (Claude Code, Codex, Cursor) and it works directly in your drobek workspace: create an app, write its files, get the compile result back on every write, and hand the user a live preview URL — every change is an immutable version.';

function hints(tool: ToolDoc): string {
  const a = tool.annotations;
  return `readOnlyHint=${a.readOnlyHint}, destructiveHint=${a.destructiveHint}, idempotentHint=${a.idempotentHint}, openWorldHint=${a.openWorldHint}`;
}

function renderToolFull(tool: ToolDoc): string {
  const lines: string[] = [];
  lines.push(`### ${tool.name} — ${tool.title}`);
  lines.push(`Scope: ${tool.scope}`);
  lines.push(`Annotations: ${hints(tool)}`);
  lines.push('');
  lines.push(tool.description);
  lines.push('');
  if (tool.fields.length === 0) {
    lines.push('Input: (none)');
  } else {
    lines.push('Input:');
    for (const f of tool.fields) {
      lines.push(`- ${f.name} — ${f.type}${f.required ? '' : ' (optional)'} — ${f.description}`);
    }
  }
  lines.push('');
  lines.push(`Returns: ${tool.returns}`);
  lines.push('');
  lines.push('Example call:');
  lines.push('```json');
  lines.push(JSON.stringify({ name: tool.name, arguments: tool.example }, null, 2));
  lines.push('```');
  return lines.join('\n');
}

/** The full tool reference block (also the `drobek://docs/tools` resource body). */
export function renderToolReference(): string {
  return ['# drobek MCP tools', '', ...TOOL_DOCS.map(renderToolFull)].join('\n\n');
}

/**
 * /llms.txt — the concise index (the /llms.txt convention: an H1 title, a
 * one-line blockquote summary, then sectioned links).
 */
export function renderLlmsTxt(env: NodeJS.ProcessEnv = process.env): string {
  const app = publicAppUrl(env);
  const mcp = mcpEndpoint(env);
  // RFC 9728: the well-known suffix sits between the origin and the resource path.
  const prm = protectedResourceMetadataUrl(env);
  const toolList = TOOL_DOCS.map((t) => `- ${t.name} — ${t.title} (${t.scope})`);
  return [
    '# drobek',
    '',
    `> ${SUMMARY}`,
    '',
    '## Docs',
    `- [Full contract](${app}/llms-full.txt): the MCP connect/OAuth flow, every tool with its inputs, result shape and an example, the app briefing (stack, files, import map, rules), limits, and the error catalogue.`,
    `- [Build with your agent](${app}/build-with-your-agent): install the drobek plugin, or connect the MCP server + install the drobek skill.`,
    `- [Agent guide](${AGENT_GUIDE_URL}): docs/AGENT.md in the drobek source — how an agent connects, every tool with its scope, the briefing, the skills and llms.txt.`,
    '',
    '## Plugin (Claude Code, Codex, Cursor)',
    `- Claude Code: \`${PLUGIN_MARKETPLACE_ADD_COMMAND}\` then \`${PLUGIN_INSTALL_COMMAND}\`; build with \`${PLUGIN_BUILD_COMMAND} <idea>\`. The plugin connects ${PLUGIN_MCP_URL}.`,
    `- Codex and Cursor: install instructions in ${PLUGIN_REPO_URL}`,
    '',
    '## Connect (MCP)',
    `- MCP endpoint: ${mcp} (OAuth 2.1, PKCE S256; discovery at ${prm})`,
    `- Authorization server: ${app}`,
    '',
    '## Tools',
    ...toolList,
    '',
  ].join('\n');
}

/**
 * /llms-full.txt — the full agent contract. Rendered from the same
 * manifest as /llms.txt so it never drifts from the real tools.
 */
export function renderLlmsFull(env: NodeJS.ProcessEnv = process.env): string {
  const app = publicAppUrl(env);
  const mcp = mcpEndpoint(env);
  // RFC 9728: the well-known suffix sits between the origin and the resource path.
  const prm = protectedResourceMetadataUrl(env);
  const sections: string[] = [];

  sections.push(['# drobek — full agent contract', '', `> ${SUMMARY}`].join('\n'));

  sections.push(
    [
      '## Connect: the MCP OAuth 2.1 flow',
      '',
      'drobek exposes an OAuth-2.1-protected Streamable HTTP MCP endpoint. The connect handshake:',
      '',
      `1. Unauthenticated POST ${mcp} → 401 with \`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"\`.`,
      `2. GET ${prm} → { resource, authorization_servers } (RFC 9728).`,
      `3. GET ${app}/.well-known/oauth-authorization-server → the AS metadata (authorize/token/register endpoints; code_challenge_methods_supported includes S256).`,
      `4. Identify the client: EITHER use an https URL that serves your Client ID Metadata Document as the client_id (preferred; the document's client_id must equal that URL and its redirect_uris are validated) OR Dynamic Client Registration: POST ${app}/oauth/register { client_name, redirect_uris } → { client_id } (rate-limited per IP).`,
      `5. GET ${app}/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&scope=read%20write&resource=${mcp} → user consent → ?code=…&state=…&iss=${app}`,
      `6. POST ${app}/oauth/token (grant_type=authorization_code, code, code_verifier, redirect_uri, client_id) → { access_token, refresh_token }.`,
      `7. Connect the MCP client to ${mcp} with \`Authorization: Bearer <access_token>\`.`,
      '',
      'The `resource` MUST be exactly the MCP endpoint (else `invalid_target`), and the token is accepted only there (else 401 invalid_token). Check that the `iss` in the authorization response equals the issuer (RFC 9207). Refresh tokens rotate; reuse of an old refresh token burns the lineage.',
      '',
      'Scopes: read (list_apps, get_app, read_file, skill_info, query_data, get_logs), write (create_app, write_files, restore_version, configure_module), publish (publish — make a version live on the production URL; call it only when the user explicitly asks). The consent screen offers the requested scopes (read + write when none are requested) and the user may uncheck any; tools/list shows exactly the granted tools.',
      '',
      'The grant belongs to the USER, not to one workspace: list_apps lists every workspace with your role and the apps across them, and each tool call is authorized against your membership in the app\'s workspace (viewer+ reads, editor+ writes; a workspace or app you cannot reach answers not_found).',
      '',
      `\`drk_…\` personal API keys are an alternative Bearer for the same endpoint (same scopes, no OAuth flow); the user creates and revokes them at ${app}/me/api-keys and revokes OAuth clients at ${app}/me/connections.`,
    ].join('\n')
  );

  sections.push(renderToolReference());

  sections.push(
    [
      '## The app briefing (returned by create_app and get_app)',
      '',
      renderBriefing().replace(/^# drobek app briefing\n\n/, '').replace(/^## /gm, '### '),
    ].join('\n')
  );

  sections.push(
    [
      '## Limits',
      '',
      ...LIMITS.map((l) => `- ${l.env} (default ${l.default}) — ${l.meaning}`),
    ].join('\n')
  );

  sections.push(
    [
      '## Error catalogue',
      '',
      'A failed tool call returns `isError: true` with `{ code, message, hint }` (the hint is the fix below). Compile problems are NOT tool failures: they come back in `compile.errors[]` with their own code. code — where — meaning — fix:',
      '',
      ...ERROR_CATALOGUE.map(
        (e) => `- ${e.code} — ${e.surface} — ${e.meaning} FIX: ${e.fix}`
      ),
    ].join('\n')
  );

  sections.push(
    [
      '## Build with your agent',
      '',
      `- Claude Code plugin (MCP server ${PLUGIN_MCP_URL} + the build-app-on-drobek skill + the ${PLUGIN_BUILD_COMMAND} command): ${PLUGIN_MARKETPLACE_ADD_COMMAND} && ${PLUGIN_INSTALL_COMMAND}`,
      `- Codex and Cursor variants of the plugin: ${PLUGIN_REPO_URL}`,
      `- Install the drobek skill from a checkout of the drobek repo: ${SKILL_INSTALL_COMMAND}`,
      `- Human quickstart page: ${app}/build-with-your-agent`,
    ].join('\n')
  );

  return sections.join('\n\n') + '\n';
}
