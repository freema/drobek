/**
 * M0-04 acceptance: `tools/list` is filtered by the granted scope — for EVERY
 * one of the 8 combinations of read / write / publish, a real MCP client
 * (in-memory transport) sees exactly the expected tools, and calling a tool
 * outside the grant fails. No DB: listing never runs a tool body, and the
 * rejected call is refused before any handler.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { SCOPES, type Scope } from '../scopes.js';
import { buildMcpServer } from './mcp.js';
import type { AuthContext } from './oauth-resource.js';

function ctxFor(scopes: Scope[]): AuthContext {
  return {
    kind: 'oauth',
    credentialId: 'tok_test',
    userId: 'u_test',
    email: 'test@example.com',
    superAdmin: false,
    scope: scopes.join(' '),
    scopes,
    audience: 'http://localhost:3041/mcp',
  };
}

async function connect(scopes: Scope[]): Promise<Client> {
  const server = buildMcpServer(ctxFor(scopes));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'scope-test', version: '0' });
  await client.connect(clientSide);
  return client;
}

const READ = ['get_app', 'list_apps', 'read_file', 'skill_info'];
const WRITE = ['configure_module', 'create_app', 'restore_version', 'write_files'];
const PUBLISH = ['publish'];

const EXPECTED: Array<[Scope[], string[]]> = [
  [[], []],
  [['read'], [...READ]],
  [['write'], [...WRITE]],
  [['publish'], [...PUBLISH]],
  [['read', 'write'], [...READ, ...WRITE]],
  [['read', 'publish'], [...READ, ...PUBLISH]],
  [['write', 'publish'], [...WRITE, ...PUBLISH]],
  [['read', 'write', 'publish'], [...READ, ...WRITE, ...PUBLISH]],
];

describe('tools/list reflects the granted scope', () => {
  it('the table below covers all 8 combinations', () => {
    expect(EXPECTED).toHaveLength(2 ** SCOPES.length);
  });

  for (const [scopes, tools] of EXPECTED) {
    it(`grant "${scopes.join(' ') || '(none)'}"`, async () => {
      const client = await connect(scopes);
      try {
        const listed = (await client.listTools()).tools.map((t) => t.name);
        expect(listed.sort()).toEqual([...tools].sort());
      } finally {
        await client.close();
      }
    });
  }

  it('a read-only grant cannot call a write tool', async () => {
    const client = await connect(['read']);
    try {
      const res = await client.callTool({
        name: 'write_files',
        arguments: { app_id: 'a', files: [{ path: 'a.txt', content: 'x' }], reasoning: 'x' },
      });
      expect(res.isError).toBe(true);
      expect((res.content as { text: string }[])[0].text).toContain('write_files not found');
    } finally {
      await client.close();
    }
  });
});
