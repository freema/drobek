import { describe, expect, it } from 'vitest';
import { mcpEndpoint } from '@drobek/agent-dx';
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
