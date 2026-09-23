/**
 * DRIFT GUARD (M1b Agent DX, PHY-124) — the enforced half of the maintenance
 * rule: the set of tools the MCP server ACTUALLY registers MUST equal the set of
 * tools documented in the @drobek/agent-dx manifest (TOOL_NAMES). Add a tool to
 * the registrations below without a doc (or a doc for a tool that no longer
 * exists) and this test fails, so llms.txt / the skill can never silently drift
 * from the real tool surface.
 *
 * We build a MAXIMAL-scope MCP server (every scope granted) so every scope-gated
 * tool is registered, then read the McpServer's registered tool map. No DB is
 * touched: buildMcpServer only registers handlers; the callbacks never run here.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_DOCS, TOOL_NAMES } from '@drobek/agent-dx';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

/** Read the tool names the McpServer actually registered (SDK internal map). */
function registeredToolNames(server: McpServer): string[] {
  const map = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  return Object.keys(map);
}

describe('MCP tool ↔ agent-dx doc parity', () => {
  it('every registered tool has a doc, and every doc maps to a registered tool', () => {
    const server = buildMcpServer(FULL_SCOPE_CTX);
    const registered = registeredToolNames(server).sort();
    const documented = [...TOOL_NAMES].sort();
    expect(registered).toEqual(documented);
  });

  it('the tool → scope table names exactly the documented tools', () => {
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("each doc's scope line starts with the scope the table enforces", () => {
    for (const doc of TOOL_DOCS) {
      const scope = TOOL_SCOPES[doc.name as keyof typeof TOOL_SCOPES];
      expect(doc.scope, doc.name).toMatch(
        scope === null ? /^always available/ : new RegExp(`^${scope}\\b`)
      );
    }
  });

  it('registers no removed upload-pipeline tool under full scope', () => {
    const names = registeredToolNames(buildMcpServer(FULL_SCOPE_CTX));
    for (const gone of ['deploy_init', 'deploy_commit', 'deploy_status', 'rollback']) {
      expect(names).not.toContain(gone);
    }
    expect(names).toHaveLength(10);
  });
});
