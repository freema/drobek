/**
 * `tools/list` is filtered by the granted scope — for EVERY
 * one of the 8 combinations of read / write / publish, a real MCP client
 * (in-memory transport) sees exactly the expected tools, and calling a tool
 * outside the grant fails. No DB: listing never runs a tool body, and the
 * rejected call is refused before any handler.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SERVER_INSTRUCTIONS } from '@drobek/agent-dx';
import { describe, expect, it } from 'vitest';
import { SCOPES, type Scope } from '../scopes.js';
import { buildMcpServer } from './mcp.js';
import type { AuthContext } from './oauth-resource.js';

function ctxFor(scopes: Scope[], superAdmin = false): AuthContext {
  return {
    kind: 'oauth',
    credentialId: 'tok_test',
    oauthClientId: null,
    userId: 'u_test',
    email: 'test@example.com',
    superAdmin,
    scope: scopes.join(' '),
    scopes,
    audience: 'http://localhost:3041/mcp',
  };
}

async function connect(scopes: Scope[], superAdmin = false): Promise<Client> {
  const server = buildMcpServer(ctxFor(scopes, superAdmin));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'scope-test', version: '0' });
  await client.connect(clientSide);
  return client;
}

const READ = ['get_app', 'get_logs', 'list_apps', 'list_assets', 'list_domains', 'list_members', 'list_upstreams', 'query_data', 'read_file', 'skill_info'];
const WRITE = [
  'add_domain',
  'configure_module',
  'create_app',
  'create_asset_upload',
  'delete_asset',
  'delete_workspace',
  'duplicate_app',
  'register_upstream',
  'remove_domain',
  'remove_member',
  'remove_upstream',
  'restore_version',
  'set_member_role',
  'sync_now',
  'verify_domain',
  'write_files',
];
const PUBLISH = ['publish', 'set_gallery_listing', 'set_primary_domain'];

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

  it('set_workspace_publishing exists only for a super-admin with the publish scope', async () => {
    for (const [scopes, superAdmin, listed] of [
      [['read', 'write', 'publish'], true, true],
      [['read', 'write'], true, false],
      [['read', 'write', 'publish'], false, false],
    ] as Array<[Scope[], boolean, boolean]>) {
      const client = await connect(scopes, superAdmin);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names.includes('set_workspace_publishing'), `${scopes.join(' ')} super-admin=${superAdmin}`).toBe(listed);
      } finally {
        await client.close();
      }
    }
  });

  it('initialize carries the server instructions naming list_apps and the start skill', async () => {
    const client = await connect(['read']);
    try {
      const text = client.getInstructions() ?? '';
      expect(text).toBe(SERVER_INSTRUCTIONS);
      expect(text).toContain('`list_apps`');
      expect(text).toContain("skill_info('start')");
    } finally {
      await client.close();
    }
  });

  it('a read + write grant cannot list an app in the gallery (publish scope)', async () => {
    const client = await connect(['read', 'write']);
    try {
      const res = await client.callTool({
        name: 'set_gallery_listing',
        arguments: { app_id: 'a', listed: true, description: 'x', user_confirmed: true },
      });
      expect(res.isError).toBe(true);
      expect((res.content as { text: string }[])[0].text).toContain('set_gallery_listing not found');
    } finally {
      await client.close();
    }
  });

  it('a read + write grant cannot set the primary domain (publish scope)', async () => {
    const client = await connect(['read', 'write']);
    try {
      const res = await client.callTool({
        name: 'set_primary_domain',
        arguments: { app_id: 'a', host: 'shop.example.com', user_confirmed: true },
      });
      expect(res.isError).toBe(true);
      expect((res.content as { text: string }[])[0].text).toContain('set_primary_domain not found');
    } finally {
      await client.close();
    }
  });

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
