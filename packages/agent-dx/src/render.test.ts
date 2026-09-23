import { describe, expect, it } from 'vitest';
import { ERROR_CATALOGUE } from './errors-catalogue.js';
import { LIMITS } from './limits.js';
import {
  PLUGIN_BUILD_COMMAND,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_MARKETPLACE_ADD_COMMAND,
  PLUGIN_MCP_URL,
  PLUGIN_REPO_URL,
} from './plugin.js';
import {
  AGENT_GUIDE_URL,
  DOCS_RESOURCE_LLMS_FULL,
  SKILL_INSTALL_COMMAND,
  renderLlmsFull,
  renderLlmsTxt,
  renderToolReference,
} from './render.js';
import { TOOL_DOCS, TOOL_NAMES } from './tools.js';

const ENV = {
  PUBLIC_APP_URL: 'http://localhost:3041',
} satisfies NodeJS.ProcessEnv;

describe('renderLlmsTxt', () => {
  const txt = renderLlmsTxt(ENV);

  it('follows the /llms.txt convention: H1 title + blockquote summary + sections', () => {
    expect(txt.startsWith('# drobek\n')).toBe(true);
    expect(txt).toContain('\n> ');
    expect(txt).toContain('## Docs');
    expect(txt).toContain('## Tools');
  });

  it('links llms-full and the build page and shows the MCP endpoint', () => {
    expect(txt).toContain('http://localhost:3041/llms-full.txt');
    expect(txt).toContain('http://localhost:3041/build-with-your-agent');
    expect(txt).toContain('http://localhost:3041/mcp');
    expect(AGENT_GUIDE_URL).toBe('https://github.com/freema/drobek/blob/main/docs/AGENT.md');
    expect(txt).toContain(`[Agent guide](${AGENT_GUIDE_URL})`);
    expect(txt).toContain(
      'http://localhost:3041/.well-known/oauth-protected-resource/mcp'
    );
  });

  it('lists every tool name', () => {
    for (const name of TOOL_NAMES) expect(txt).toContain(name);
  });

  it('carries the plugin install for Claude Code + the Codex/Cursor pointer (M0-10)', () => {
    expect(txt).toContain('## Plugin (Claude Code, Codex, Cursor)');
    expect(txt).toContain(PLUGIN_MARKETPLACE_ADD_COMMAND);
    expect(txt).toContain(PLUGIN_INSTALL_COMMAND);
    expect(txt).toContain(PLUGIN_BUILD_COMMAND);
    expect(txt).toContain(PLUGIN_MCP_URL);
    expect(txt).toContain(PLUGIN_REPO_URL);
    expect(PLUGIN_MARKETPLACE_ADD_COMMAND).toBe('claude plugin marketplace add freema/drobek-plugin');
    expect(PLUGIN_INSTALL_COMMAND).toBe('claude plugin install drobek@drobek');
    expect(PLUGIN_BUILD_COMMAND).toBe('/drobek:build-app');
  });
});

describe('renderLlmsFull', () => {
  const full = renderLlmsFull(ENV);

  it('documents every manifest tool completely: each input field, its result shape and an example (M0-10 parity)', () => {
    // With the @drobek/oauth parity test (registered MCP tools == TOOL_DOCS),
    // this closes the chain: tools/list == manifest == llms-full.txt.
    for (const t of TOOL_DOCS) {
      const start = full.indexOf(`### ${t.name} — ${t.title}`);
      expect(start, t.name).toBeGreaterThan(-1);
      const next = full.indexOf('\n### ', start + 1);
      const section = full.slice(start, next === -1 ? undefined : next);
      expect(section, t.name).toContain(`Scope: ${t.scope}`);
      for (const f of t.fields) expect(section, `${t.name}.${f.name}`).toContain(`- ${f.name} — `);
      if (t.fields.length === 0) expect(section, t.name).toContain('Input: (none)');
      expect(section, t.name).toContain(`Returns: ${t.returns}`);
      expect(section, t.name).toContain(`"name": "${t.name}"`);
    }
  });

  it('contains every current tool with annotations, result shape and an example call', () => {
    for (const name of TOOL_NAMES) expect(full).toContain(`### ${name} — `);
    expect(full).toContain('Example call:');
    expect(full).toContain('Returns: ');
    expect(full).toContain('Annotations: readOnlyHint=false, destructiveHint=true, openWorldHint=false');
  });

  it('carries the app briefing (stack, import map, rules)', () => {
    expect(full).toContain('## The app briefing (returned by create_app and get_app)');
    expect(full).toContain('### Stack');
    expect(full).toContain('https://esm.sh/react@');
    expect(full).toContain('app_locked');
  });

  it('no longer documents the removed data / insight tools', () => {
    for (const gone of ['whoami', 'collection_define', 'record_create', 'record_query', 'app_errors', 'app_logs', 'public-write']) {
      expect(full, gone).not.toContain(gone);
      expect(renderLlmsTxt(ENV), gone).not.toContain(gone);
    }
  });

  it('documents the MCP connect / OAuth flow', () => {
    expect(full).toContain('.well-known/oauth-protected-resource');
    expect(full).toContain('.well-known/oauth-authorization-server');
    expect(full).toContain('/oauth/register');
    expect(full).toContain('/oauth/authorize');
    expect(full).toContain('/oauth/token');
    expect(full).toContain('S256');
  });

  it('documents the M0-04 model: user-bound grants, read/write/publish, CIMD, iss, API keys', () => {
    expect(full).toContain('Scopes: read (');
    expect(full).toContain('publish');
    expect(full).toContain('Client ID Metadata Document');
    expect(full).toContain('invalid_target');
    expect(full).toContain('iss=');
    expect(full).toContain('list_apps lists every workspace');
    expect(full).toContain('drk_');
    for (const old of ['mcp:whoami', 'apps:read', 'deploy:write', 'data:read', 'data:write']) {
      expect(full, old).not.toContain(old);
      expect(renderLlmsTxt(ENV), old).not.toContain(old);
    }
  });

  it('puts RFC 9728 discovery on the resource origin, NOT the /mcp endpoint', () => {
    // The protected-resource metadata is at <mcp-origin>/.well-known/…, never
    // <mcp-origin>/mcp/.well-known/… — a wrong URL here 404s any agent.
    expect(full).not.toContain('/mcp/.well-known/oauth-protected-resource');
    expect(renderLlmsTxt()).not.toContain(
      '/mcp/.well-known/oauth-protected-resource'
    );
  });

  it('no longer documents the removed upload/deploy pipeline', () => {
    // doc-lint: allow — retired tool names, asserted absent
    for (const gone of ['deploy_init', 'deploy_commit', 'deploy_status', '/:ws/app/:slug']) {
      expect(full).not.toContain(gone);
      expect(renderLlmsTxt(ENV)).not.toContain(gone);
    }
  });

  it('contains the error catalogue (every code)', () => {
    expect(full).toContain('## Error catalogue');
    for (const e of ERROR_CATALOGUE) expect(full).toContain(e.code);
    // task-named exemplars
    for (const code of ['app_locked', 'not_found', 'compile_error', 'secret_in_source', 'limit_exceeded', 'invalid_params', 'invalid_path', 'busy']) {
      expect(full, code).toContain(`- ${code} — `);
    }
    expect(full).toContain('redirect_uri');
    expect(full).toContain('{ code, message, hint }');
  });

  it('contains the limits (every env cap)', () => {
    for (const l of LIMITS) expect(full).toContain(l.env);
    expect(full).toContain('COMPILE_MAX_TOTAL_BYTES');
    expect(full).not.toContain('DATA_MAX_DOCS_PER_APP');
  });

  it('surfaces the plugin + skill install commands + docs resource uri consistency', () => {
    expect(full).toContain(`${PLUGIN_MARKETPLACE_ADD_COMMAND} && ${PLUGIN_INSTALL_COMMAND}`);
    expect(full).toContain(PLUGIN_REPO_URL);
    expect(full).toContain(SKILL_INSTALL_COMMAND);
    expect(DOCS_RESOURCE_LLMS_FULL).toBe('drobek://docs/llms-full');
  });
});

describe('renderToolReference', () => {
  it('renders one section per tool', () => {
    const ref = renderToolReference();
    for (const name of TOOL_NAMES) expect(ref).toContain(`### ${name} —`);
  });
});
