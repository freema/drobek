import { describe, expect, it } from 'vitest';
import { LIMITS, renderBriefing } from '@drobek/agent-dx';
import { DEFAULT_LIMITS } from '@drobek/compile';
import { mcpMaxBodyBytes } from './request-limit.js';

describe('mcpMaxBodyBytes', () => {
  it('defaults to twice the version total, so a maximal write_files call fits with its JSON escaping', () => {
    expect(mcpMaxBodyBytes({})).toBe(2 * DEFAULT_LIMITS.maxTotalBytes);
    expect(mcpMaxBodyBytes({})).toBe(10 * 1024 * 1024);
    expect(mcpMaxBodyBytes({ COMPILE_MAX_TOTAL_BYTES: '1048576' })).toBe(2 * 1024 * 1024);
    expect(mcpMaxBodyBytes({}, 3000)).toBe(6000);
  });

  it('MCP_MAX_BODY_BYTES overrides it; an invalid value keeps the default', () => {
    expect(mcpMaxBodyBytes({ MCP_MAX_BODY_BYTES: '2048' })).toBe(2048);
    for (const bad of ['', '0', '-5', '1.5', 'big']) expect(mcpMaxBodyBytes({ MCP_MAX_BODY_BYTES: bad }), bad).toBe(10 * 1024 * 1024);
  });

  it('the agent-dx limits table and the default briefing state the same default', () => {
    const doc = LIMITS.find((l) => l.env === 'MCP_MAX_BODY_BYTES');
    expect(doc?.default.startsWith(`${mcpMaxBodyBytes({})} `)).toBe(true);
    expect(renderBriefing()).toContain('one MCP request of at most 10 MiB');
  });
});
