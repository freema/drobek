import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_GUIDE_URL, mcpEndpoint } from '@drobek/agent-dx';
import { loader } from './build-with-your-agent';

describe('/build-with-your-agent loader', () => {
  it('carries the plugin install (Claude Code) + the Codex/Cursor repo pointer (M0-10)', () => {
    const data = loader();
    expect(data.plugin.commands).toBe(
      'claude plugin marketplace add freema/drobek-plugin\nclaude plugin install drobek@drobek'
    );
    expect(data.plugin.buildExample.startsWith('/drobek:build-app ')).toBe(true);
    expect(data.plugin.mcpUrl).toBe('https://drobek.app/mcp');
    expect(data.plugin.repoUrl).toBe('https://github.com/freema/drobek-plugin');
  });

  it('keeps the manual path: this server’s MCP endpoint, the skill install and every tool', () => {
    const data = loader();
    expect(data.mcpUrl).toBe(mcpEndpoint());
    expect(data.installCommand).toBe('cp -r skills/drobek ~/.claude/skills/drobek');
    expect(data.tools.map((t) => t.name)).toContain('publish');
  });
});

describe('/build-with-your-agent agent guide link (NSO-366)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('links the agent guide on GitHub without DOCS_URL', () => {
    vi.stubEnv('DOCS_URL', '');
    expect(loader().guideUrl).toBe(AGENT_GUIDE_URL);
  });

  it('links <DOCS_URL>/agent when DOCS_URL is set', () => {
    vi.stubEnv('DOCS_URL', 'https://www.drobek.app/docs');
    expect(loader().guideUrl).toBe('https://www.drobek.app/docs/agent');
  });
});
