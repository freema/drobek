/**
 * How each supported MCP client connects to this server — the dashboard's
 * client picker on /me. The steps are the ones docs/AGENT.md ("Connect")
 * gives, with this server's MCP URL filled in (connect.test.ts keeps them in
 * step with the guide). The plugin commands install the hosted drobek, so
 * they are offered only when this server IS the hosted one.
 */
import {
  PLUGIN_BUILD_COMMAND,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_MARKETPLACE,
  PLUGIN_MARKETPLACE_ADD_COMMAND,
  PLUGIN_MCP_URL,
  PLUGIN_NAME,
  PLUGIN_REPO,
} from './plugin.js';

export type ConnectStep = { kind: 'text'; text: string } | { kind: 'code'; code: string; label: string };

export interface ConnectClient {
  id: 'claude-code' | 'claude-app' | 'cursor' | 'codex';
  label: string;
  steps: ConnectStep[];
}

const text = (t: string): ConnectStep => ({ kind: 'text', text: t });
const code = (label: string, c: string): ConnectStep => ({ kind: 'code', label, code: c });

/** An idea for the first app, the same one /build-with-your-agent shows. */
const FIRST_APP_IDEA = 'a tip calculator that splits the bill';

/** The prompt that asks a connected agent for its first app in `workspaceSlug`. */
export function firstAppPrompt(workspaceSlug: string): string {
  return `Use drobek to build ${FIRST_APP_IDEA} in my workspace "${workspaceSlug}", then give me the preview link.`;
}

export function connectClients(mcpUrl: string): ConnectClient[] {
  const hosted = mcpUrl === PLUGIN_MCP_URL;
  const claudeCode: ConnectStep[] = [
    code('Claude Code command', `claude mcp add --transport http drobek ${mcpUrl}`),
    text('Then run /mcp in Claude Code → drobek → sign in.'),
  ];
  if (hosted) {
    claudeCode.push(
      text('Or install the plugin, which bundles the server, the build skill and a command:'),
      code('Plugin install commands', `${PLUGIN_MARKETPLACE_ADD_COMMAND}\n${PLUGIN_INSTALL_COMMAND}`),
      text(`Then ask with ${PLUGIN_BUILD_COMMAND} <idea>.`)
    );
  }
  const codex: ConnectStep[] = hosted
    ? [
        code(
          'Codex commands',
          `codex plugin marketplace add ${PLUGIN_REPO}\ncodex plugin add ${PLUGIN_NAME}@${PLUGIN_MARKETPLACE}\ncodex mcp login drobek`
        ),
        text('codex mcp login drobek opens the sign-in in the browser; restart Codex afterwards.'),
      ]
    : [
        text(`Add an MCP server named drobek with the URL ${mcpUrl} to Codex's MCP configuration.`),
        code('Codex sign-in command', 'codex mcp login drobek'),
        text('It opens the sign-in in the browser; restart Codex afterwards.'),
      ];
  return [
    { id: 'claude-code', label: 'Claude Code', steps: claudeCode },
    {
      id: 'claude-app',
      label: 'Claude (web and desktop)',
      steps: [
        text('Add a custom connector with this URL and sign in when asked:'),
        code('MCP URL', mcpUrl),
        text('The server must be reachable over public HTTPS for that.'),
      ],
    },
    {
      id: 'cursor',
      label: 'Cursor',
      steps: [
        text('Add the server to ~/.cursor/mcp.json:'),
        code('Cursor configuration', JSON.stringify({ mcpServers: { drobek: { url: mcpUrl } } }, null, 2)),
        text('Sign in when Cursor asks.'),
      ],
    },
    { id: 'codex', label: 'Codex', steps: codex },
  ];
}
