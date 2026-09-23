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

const READ = ['app_errors', 'app_logs', 'list_apps', 'record_query', 'record_read'];
const WRITE = ['collection_define', 'record_create', 'record_delete', 'record_update'];

const EXPECTED: Array<[Scope[], string[]]> = [
  [[], ['whoami']],
  [['read'], ['whoami', ...READ]],
  [['write'], ['whoami', ...WRITE]],
  [['publish'], ['whoami']],
  [['read', 'write'], ['whoami', ...READ, ...WRITE]],
  [['read', 'publish'], ['whoami', ...READ]],
  [['write', 'publish'], ['whoami', ...WRITE]],
  [['read', 'write', 'publish'], ['whoami', ...READ, ...WRITE]],
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
        name: 'record_create',
        arguments: { locator: { workspace: 'w', slug: 'a' }, collection: 'c', doc: {} },
      });
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
