/**
 * DRIFT GUARD (PHY-124, M0-05) — the tools the MCP server ACTUALLY registers
 * must equal the @drobek/agent-dx manifest (TOOL_DOCS): the same names, the
 * same input field names, the same annotations, and the scope each doc names
 * must be the one TOOL_SCOPES enforces. Add or change a tool without its doc
 * (or the other way round) and this fails, so llms.txt / llms-full.txt / the
 * skill can never silently drift from tools/list.
 *
 * A MAXIMAL-scope server (every scope granted) is listed over an in-memory
 * MCP client. No DB is touched: listing never runs a tool body.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { TOOL_DOCS, TOOL_NAMES } from '@drobek/agent-dx';
import { SCOPES, TOOL_SCOPES } from '../scopes.js';
import { buildMcpServer } from './mcp.js';
import type { AuthContext } from './oauth-resource.js';

const FULL_SCOPE_CTX: AuthContext = {
  kind: 'oauth',
  credentialId: 'tok_test',
  userId: 'u_test',
  email: 'test@example.com',
  superAdmin: false,
  scope: SCOPES.join(' '),
  scopes: [...SCOPES],
  audience: 'http://localhost:3041/mcp',
};

async function listedTools() {
  const server = buildMcpServer(FULL_SCOPE_CTX);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 'parity', version: '0' });
  await client.connect(c);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

describe('MCP tools/list ↔ agent-dx TOOL_DOCS parity', () => {
  it('registers exactly the documented tools, in manifest order', async () => {
    const tools = await listedTools();
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(tools).toHaveLength(11);
  });

  it('each tool has the documented title, description, annotations and input fields', async () => {
    const tools = await listedTools();
    for (const doc of TOOL_DOCS) {
      const tool = tools.find((t) => t.name === doc.name)!;
      expect(tool.title, doc.name).toBe(doc.title);
      expect(tool.description, doc.name).toBe(doc.description);
      expect(tool.annotations, doc.name).toEqual({ title: doc.title, ...doc.annotations });
      const props = Object.keys((tool.inputSchema.properties ?? {}) as object);
      expect(props, doc.name).toEqual(doc.fields.map((f) => f.name));
      const required = (tool.inputSchema.required ?? []) as string[];
      expect([...required].sort(), doc.name).toEqual(
        doc.fields.filter((f) => f.required).map((f) => f.name).sort()
      );
    }
  });

  it('the tool → scope table names exactly the documented tools', () => {
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("each doc's scope line starts with the scope the table enforces", () => {
    for (const doc of TOOL_DOCS) {
      const scope = TOOL_SCOPES[doc.name as keyof typeof TOOL_SCOPES];
      expect(doc.scope, doc.name).toMatch(new RegExp(`^${scope}\\b`));
    }
  });

  it('no removed tool is registered under full scope', async () => {
    const names = (await listedTools()).map((t) => t.name);
    for (const gone of [
      'whoami',
      'collection_define',
      'record_create',
      'record_read',
      'record_update',
      'record_delete',
      'record_query',
      'app_errors',
      'app_logs',
      'deploy_init', // doc-lint: allow — retired tool, asserted absent
      'deploy_commit', // doc-lint: allow — retired tool, asserted absent
      'deploy_status',
      'rollback',
    ]) {
      expect(names).not.toContain(gone);
    }
  });
});
