/**
 * The agent-docs renderers (M1b Agent DX, PHY-124) — PURE, react-free string
 * builders the web routes (/llms.txt, /llms-full.txt, /build-with-your-agent)
 * and the MCP docs resources render from, so every surface stays in sync with
 * the TOOL_DOCS manifest, the error catalogue, and the limits.
 */
import { ERROR_CATALOGUE } from './errors-catalogue.js';
import { LIMITS } from './limits.js';
import { TOOL_DOCS, type ToolDoc } from './tools.js';
import { mcpEndpoint, publicAppUrl, publicMcpUrl } from './urls.js';

/** The one-command skill install (self-host repo → Claude Code skills dir). */
export const SKILL_INSTALL_COMMAND = 'cp -r skills/drobek ~/.claude/skills/drobek';

/** MCP docs resource URIs (stable — referenced by agents + tests). */
export const DOCS_RESOURCE_LLMS_FULL = 'drobek://docs/llms-full';
export const DOCS_RESOURCE_TOOLS = 'drobek://docs/tools';

const SUMMARY =
  'drobek is MCP-native hosting for vibecoded static micro-apps. Connect the drobek MCP server from your agent (Claude Code, Cursor), deploy a folder of static files, and get a live URL — with an optional JSON-schema-backed Data API for dynamic apps.';

function renderToolFull(tool: ToolDoc): string {
  const lines: string[] = [];
  lines.push(`### ${tool.name} — ${tool.title}`);
  lines.push(`Scope: ${tool.scope}`);
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
  // RFC 9728 metadata lives on the resource ORIGIN, not the /mcp endpoint.
  const mcpOrigin = publicMcpUrl(env);
  const toolList = TOOL_DOCS.map((t) => `- ${t.name} — ${t.title} (${t.scope})`);
  return [
    '# drobek',
    '',
    `> ${SUMMARY}`,
    '',
    '## Docs',
    `- [Full delivery-stack contract](${app}/llms-full.txt): the MCP connect/OAuth flow, every tool with its input schema + an example, the REST Data API, the deploy flow, the serving model, quotas/limits, and the error catalogue.`,
    `- [Build with your agent](${app}/build-with-your-agent): connect the MCP server + install the drobek skill.`,
    '',
    '## Connect (MCP)',
    `- MCP endpoint: ${mcp} (OAuth 2.1, PKCE S256; discovery at ${mcpOrigin}/.well-known/oauth-protected-resource)`,
    `- Authorization server: ${app}`,
    '',
    '## Tools',
    ...toolList,
    '',
    '## REST Data API',
    '- GET/POST  /:ws/app/:slug/data/:collection',
    '- GET/PATCH/DELETE  /:ws/app/:slug/data/:collection/:id',
    '',
    '## Deploy',
    '- deploy_init (index.html at root) → PUT the missing files → deploy_commit → poll deploy_status until ready → open the live URL.',
    '',
  ].join('\n');
}

/**
 * /llms-full.txt — the full delivery-stack contract. Rendered from the same
 * manifest as /llms.txt so it never drifts from the real tools.
 */
export function renderLlmsFull(env: NodeJS.ProcessEnv = process.env): string {
  const app = publicAppUrl(env);
  const mcp = mcpEndpoint(env);
  // RFC 9728 metadata lives on the resource ORIGIN, not the /mcp endpoint.
  const mcpOrigin = publicMcpUrl(env);
  const sections: string[] = [];

  sections.push(['# drobek — full delivery-stack contract', '', `> ${SUMMARY}`].join('\n'));

  sections.push(
    [
      '## Connect: the MCP OAuth 2.1 flow',
      '',
      'drobek exposes an OAuth-2.1-protected Streamable HTTP MCP endpoint. The connect handshake:',
      '',
      `1. Unauthenticated POST ${mcp} → 401 with \`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"\`.`,
      `2. GET ${mcpOrigin}/.well-known/oauth-protected-resource → { resource, authorization_servers } (RFC 9728).`,
      `3. GET ${app}/.well-known/oauth-authorization-server → the AS metadata (authorize/token/register endpoints; code_challenge_methods_supported includes S256).`,
      `4. Dynamic Client Registration: POST ${app}/oauth/register { client_name, redirect_uris } → { client_id }.`,
      `5. GET ${app}/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&scope=…&resource=${mcp} → user consent → ?code=…`,
      `6. POST ${app}/oauth/token (grant_type=authorization_code, code, code_verifier, redirect_uri, client_id) → { access_token, refresh_token }.`,
      `7. Connect the MCP client to ${mcp} with \`Authorization: Bearer <access_token>\`.`,
      '',
      'The token audience (RFC 8707 `resource`) MUST equal the MCP endpoint or the call is rejected 401. Refresh tokens rotate; reuse of an old refresh token burns the lineage.',
      '',
      'Scopes: mcp:whoami (always), apps:read, deploy:write, data:read, data:write. A client that requests none gets the mcp:whoami + apps:read baseline. tools/list reflects the granted scope.',
    ].join('\n')
  );

  sections.push(renderToolReference());

  sections.push(
    [
      '## REST Data API',
      '',
      'Same-origin REST over the same collections the data tools use. All responses are `no-store` JSON.',
      '',
      '- GET  /:ws/app/:slug/data/:collection — list/query (query params: equality filters by field, plus `limit`, `cursor`, `sort`, `dir`). Returns { records, nextCursor }.',
      '- POST /:ws/app/:slug/data/:collection — create a document (JSON body, validated against the schema). Returns the stored document.',
      '- GET  /:ws/app/:slug/data/:collection/:id — read one document.',
      '- PATCH /:ws/app/:slug/data/:collection/:id — shallow-merge patch, re-validated.',
      '- DELETE /:ws/app/:slug/data/:collection/:id — soft-delete.',
      '',
      'Access modes (set per collection at collection_define):',
      '- public-read — anonymous reads; writes need an editor+ member.',
      '- public-write — anonymous reads AND writes (the schema is still validated).',
      '- locked — no anonymous access; reads need a viewer+ member, writes an editor+ member.',
      '- owner-only — RESERVED for U11 end-user auth; record ops are rejected as not_implemented for now.',
      '',
      'Every write (any mode) is schema-validated, write-rate-limited, and quota-capped.',
    ].join('\n')
  );

  sections.push(
    [
      '## Deploy flow',
      '',
      '1. Structure the app: an `index.html` at the ROOT, relative asset paths, all files static.',
      '2. deploy_init with the file manifest ({ path, sha256, bytes }[]). It returns presigned PUT URLs for ONLY the files whose content is not already stored (content-hash dedup).',
      '3. PUT each file to its presigned URL (the sink verifies the sha256).',
      '4. deploy_commit to enqueue the build/lint/activate job.',
      '5. Poll deploy_status: awaiting_upload → queued → linting → storing → activating → ready | failed.',
      '6. On `ready`, open the returned live URL. On `failed`, read the lint report.',
      '',
      'Strict lint blocks non-static bundles (e.g. anything pulling chromium/puppeteer) — such a deploy ends `failed` and never activates. Use `rollback` to repoint an app to a prior ready deploy.',
    ].join('\n')
  );

  sections.push(
    [
      '## Serving model',
      '',
      `- URL shape: ${app}/:ws/app/:slug/* (workspace slug + app slug).`,
      '- Hardened same-origin serving with a strict Content-Security-Policy; hashed assets are served immutable/cacheable.',
      '- Only the active (ready) deploy is served; a rollback repoints which deploy is active.',
    ].join('\n')
  );

  sections.push(
    [
      '## Quotas & limits (env-driven caps)',
      '',
      ...LIMITS.map((l) => `- ${l.env} (default ${l.default}) — ${l.meaning}`),
    ].join('\n')
  );

  sections.push(
    [
      '## Error catalogue',
      '',
      'Every failure carries a stable `code`. code — where — meaning — fix:',
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
      `- Install the drobek skill: ${SKILL_INSTALL_COMMAND}`,
      `- Human quickstart page: ${app}/build-with-your-agent`,
    ].join('\n')
  );

  return sections.join('\n\n') + '\n';
}
