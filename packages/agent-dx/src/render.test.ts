import { describe, expect, it } from 'vitest';
import { ERROR_CATALOGUE } from './errors-catalogue.js';
import { LIMITS } from './limits.js';
import {
  DOCS_RESOURCE_LLMS_FULL,
  SKILL_INSTALL_COMMAND,
  renderLlmsFull,
  renderLlmsTxt,
  renderToolReference,
} from './render.js';
import { TOOL_NAMES } from './tools.js';

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
    expect(txt).toContain(
      'http://localhost:3041/.well-known/oauth-protected-resource/mcp'
    );
  });

  it('lists every tool name', () => {
    for (const name of TOOL_NAMES) expect(txt).toContain(name);
  });
});

describe('renderLlmsFull', () => {
  const full = renderLlmsFull(ENV);

  it('contains every current tool name with an example call', () => {
    for (const name of TOOL_NAMES) expect(full).toContain(name);
    // spot-check the explicit tool set
    for (const name of [
      'whoami',
      'list_apps',
      'collection_define',
      'record_create',
      'record_read',
      'record_update',
      'record_delete',
      'record_query',
    ]) {
      expect(full).toContain(name);
    }
    expect(full).toContain('Example call:');
  });

  it('documents the data access modes', () => {
    expect(full).toContain('public-read');
    expect(full).toContain('public-write');
    expect(full).toContain('locked');
    expect(full).toContain('owner-only');
  });

  it('documents the MCP connect / OAuth flow', () => {
    expect(full).toContain('.well-known/oauth-protected-resource');
    expect(full).toContain('.well-known/oauth-authorization-server');
    expect(full).toContain('/oauth/register');
    expect(full).toContain('/oauth/authorize');
    expect(full).toContain('/oauth/token');
    expect(full).toContain('S256');
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
    for (const gone of ['deploy_init', 'deploy_commit', 'deploy_status', '/:ws/app/:slug']) {
      expect(full).not.toContain(gone);
      expect(renderLlmsTxt(ENV)).not.toContain(gone);
    }
  });

  it('contains the error catalogue (every code)', () => {
    expect(full).toContain('## Error catalogue');
    for (const e of ERROR_CATALOGUE) expect(full).toContain(e.code);
    // task-named exemplars
    expect(full).toContain('validation_failed');
    expect(full).toContain('too_many_docs');
    expect(full).toContain('redirect_uri');
  });

  it('contains the limits (every env cap)', () => {
    for (const l of LIMITS) expect(full).toContain(l.env);
    expect(full).toContain('DATA_MAX_DOCS_PER_APP');
    expect(full).toContain('COMPILE_MAX_TOTAL_BYTES');
  });

  it('surfaces the skill install command + docs resource uri consistency', () => {
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
