import { describe, expect, it } from 'vitest';
import { mcpEndpoint, protectedResourceMetadataUrl, publicAppUrl } from './urls.js';

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
