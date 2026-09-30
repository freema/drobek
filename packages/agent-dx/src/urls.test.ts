import { describe, expect, it } from 'vitest';
import { DOC_PAGES, docPageUrl, docsUrl, docsUrlConfigError, mcpEndpoint, protectedResourceMetadataUrl, publicAppUrl } from './urls.js';

describe('agent-dx public URLs', () => {
  it('derives the MCP endpoint from PUBLIC_APP_URL (single process)', () => {
    const env = { PUBLIC_APP_URL: 'https://drobek.example/' };
    expect(publicAppUrl(env)).toBe('https://drobek.example');
    expect(mcpEndpoint(env)).toBe('https://drobek.example/mcp');
    expect(protectedResourceMetadataUrl(env)).toBe(
      'https://drobek.example/.well-known/oauth-protected-resource/mcp'
    );
  });

  it('lets PUBLIC_MCP_URL override the full endpoint URL', () => {
    const env = {
      PUBLIC_APP_URL: 'https://drobek.example',
      PUBLIC_MCP_URL: 'https://mcp.drobek.example/mcp/',
    };
    expect(mcpEndpoint(env)).toBe('https://mcp.drobek.example/mcp');
    expect(protectedResourceMetadataUrl(env)).toBe(
      'https://mcp.drobek.example/.well-known/oauth-protected-resource/mcp'
    );
  });

  it('keeps an origin-only resource on the bare well-known path', () => {
    const env = { PUBLIC_MCP_URL: 'https://mcp.drobek.example' };
    expect(protectedResourceMetadataUrl(env)).toBe(
      'https://mcp.drobek.example/.well-known/oauth-protected-resource'
    );
  });
});

describe('DOCS_URL', () => {
  it('unset → the Markdown files in the source repository', () => {
    expect(docsUrl({})).toBeNull();
    expect(docsUrlConfigError({})).toBeNull();
    expect(docsUrlConfigError({ DOCS_URL: '  ' })).toBeNull();
    expect(docPageUrl('agent', {})).toBe('https://github.com/freema/drobek/blob/main/docs/AGENT.md');
    expect(docPageUrl('agent', {}, { markdown: true })).toBe(DOC_PAGES.agent);
    expect(docPageUrl('self-hosting', {})).toBe('https://github.com/freema/drobek/blob/main/docs/SELF-HOSTING.md');
  });

  it('set → <DOCS_URL>/<slug>, the .md twin on request; a trailing slash is dropped', () => {
    const env = { DOCS_URL: 'https://www.drobek.app/docs/' };
    expect(docsUrl(env)).toBe('https://www.drobek.app/docs');
    expect(docPageUrl('agent', env)).toBe('https://www.drobek.app/docs/agent');
    expect(docPageUrl('agent', env, { markdown: true })).toBe('https://www.drobek.app/docs/agent.md');
    for (const page of Object.keys(DOC_PAGES) as (keyof typeof DOC_PAGES)[]) {
      expect(docPageUrl(page, env, { markdown: true })).toBe(`https://www.drobek.app/docs/${page}.md`);
    }
  });

  it('an invalid value stops the server at start (and is never linked)', () => {
    for (const bad of ['www.drobek.app/docs', 'ftp://docs.example.com', 'https://docs.example.com/?x=1', 'https://docs.example.com/#top', 'https://u:p@docs.example.com', 'not a url']) {
      expect(docsUrlConfigError({ DOCS_URL: bad }), bad).toMatch(/^drobek refuses to start: DOCS_URL must be an http\(s\) URL/);
      expect(docsUrl({ DOCS_URL: bad }), bad).toBeNull();
    }
    expect(docsUrlConfigError({ DOCS_URL: 'http://localhost:4000/docs' })).toBeNull();
  });
});
