import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { connectClients, firstAppPrompt } from './connect.js';
import { PLUGIN_MCP_URL } from './plugin.js';

const AGENT_MD = readFileSync(new URL('../../../docs/AGENT.md', import.meta.url), 'utf8');
const DOC_URL = 'https://drobek.example.com/mcp';

function codes(mcpUrl: string, id: string): string[] {
  const client = connectClients(mcpUrl).find((c) => c.id === id);
  if (!client) throw new Error(`no client ${id}`);
  return client.steps.flatMap((s) => (s.kind === 'code' ? [s.code] : []));
}

describe('connectClients — the /me client picker', () => {
  it('offers exactly the clients the agent guide documents', () => {
    expect(connectClients(DOC_URL).map((c) => c.label)).toEqual([
      'Claude Code',
      'Claude (web and desktop)',
      'Cursor',
      'Codex',
    ]);
  });

  it('every copyable snippet for a self-hosted server is the guide text with this server URL', () => {
    for (const client of connectClients(DOC_URL)) {
      for (const snippet of codes(DOC_URL, client.id)) {
        expect(AGENT_MD, `${client.id}: ${snippet}`).toContain(snippet);
      }
    }
  });

  it('fills in the server URL instead of the example host', () => {
    const url = 'https://drobek.acme.test/mcp';
    expect(codes(url, 'claude-code')).toEqual([`claude mcp add --transport http drobek ${url}`]);
    expect(codes(url, 'claude-app')).toEqual([url]);
    expect(JSON.parse(codes(url, 'cursor')[0]!)).toEqual({ mcpServers: { drobek: { url } } });
  });

  it('offers the plugin (which installs the hosted drobek) only on the hosted server', () => {
    expect(codes(DOC_URL, 'claude-code').join('\n')).not.toContain('claude plugin');
    expect(codes(DOC_URL, 'codex').join('\n')).not.toContain('codex plugin');
    const hostedClaude = codes(PLUGIN_MCP_URL, 'claude-code');
    const hostedCodex = codes(PLUGIN_MCP_URL, 'codex');
    for (const snippet of [...hostedClaude, ...hostedCodex]) {
      expect(AGENT_MD).toContain(snippet.replace(PLUGIN_MCP_URL, DOC_URL));
    }
    expect(hostedClaude.join('\n')).toContain('claude plugin install drobek@drobek');
    expect(hostedCodex.join('\n')).toContain('codex mcp login drobek');
  });

  it('the first-app prompt names the workspace the agent should use', () => {
    expect(firstAppPrompt('tomas')).toContain('"tomas"');
    expect(firstAppPrompt('tomas')).toMatch(/preview link/);
  });
});
