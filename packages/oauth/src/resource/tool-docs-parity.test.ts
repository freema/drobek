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
import { TOOL_NAMES } from '@drobek/agent-dx';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildMcpServer } from './mcp.js';
import type { AuthContext } from './oauth-resource.js';

const FULL_SCOPE_CTX: AuthContext = {
  userId: 'u_test',
  email: 'test@example.com',
  workspaceId: 'w_test',
  workspaceSlug: 'test-ws',
  workspaceName: 'Test WS',
  role: 'workspace-admin',
  scope: 'mcp:whoami apps:read deploy:write data:read data:write',
  audience: 'http://localhost:3042',
  superAdmin: false,
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

  it('registers all 14 M1a/M1b tools under full scope', () => {
    const server = buildMcpServer(FULL_SCOPE_CTX);
    expect(registeredToolNames(server)).toHaveLength(14);
  });
});
