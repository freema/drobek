import { afterEach, describe, expect, it } from 'vitest';
import {
  mcpResourceUri,
  protectedResourceMetadata,
  resourceMetadataUrl,
} from './oauth-resource.js';

const saved = {
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
  PUBLIC_MCP_URL: process.env.PUBLIC_MCP_URL,
};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('MCP protected resource identity', () => {
  it('defaults the resource (token audience) to PUBLIC_APP_URL + /mcp', () => {
    process.env.PUBLIC_APP_URL = 'https://drobek.example/';
    delete process.env.PUBLIC_MCP_URL;
    expect(mcpResourceUri()).toBe('https://drobek.example/mcp');
    expect(resourceMetadataUrl()).toBe(
      'https://drobek.example/.well-known/oauth-protected-resource/mcp'
    );
    expect(protectedResourceMetadata()).toMatchObject({
      resource: 'https://drobek.example/mcp',
      authorization_servers: ['https://drobek.example'],
    });
  });

  it('honours an explicit PUBLIC_MCP_URL endpoint', () => {
    process.env.PUBLIC_APP_URL = 'https://drobek.example';
    process.env.PUBLIC_MCP_URL = 'https://mcp.drobek.example/mcp/';
    expect(mcpResourceUri()).toBe('https://mcp.drobek.example/mcp');
    expect(resourceMetadataUrl()).toBe(
      'https://mcp.drobek.example/.well-known/oauth-protected-resource/mcp'
    );
  });
});
