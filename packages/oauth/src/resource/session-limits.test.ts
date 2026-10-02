import { describe, expect, it } from 'vitest';
import { MCP_SESSION_IDLE_TTL_MS_DEFAULT, MCP_SESSIONS_PER_USER_DEFAULT, mcpSessionLimits } from './session-limits.js';

describe('mcpSessionLimits', () => {
  it('defaults to a 1 hour idle TTL and 10 sessions per user', () => {
    expect(MCP_SESSION_IDLE_TTL_MS_DEFAULT).toBe(3_600_000);
    expect(MCP_SESSIONS_PER_USER_DEFAULT).toBe(10);
    expect(mcpSessionLimits({})).toEqual({ idleTtlMs: 3_600_000, perUser: 10 });
  });

  it('MCP_SESSION_IDLE_TTL_MS and MCP_SESSIONS_PER_USER override them', () => {
    expect(mcpSessionLimits({ MCP_SESSION_IDLE_TTL_MS: '900000', MCP_SESSIONS_PER_USER: '3' })).toEqual({
      idleTtlMs: 900_000,
      perUser: 3,
    });
  });

  it('a missing, empty, zero, negative or fractional value keeps the default', () => {
    for (const bad of ['', ' ', '0', '-5', '1.5', 'often']) {
      expect(mcpSessionLimits({ MCP_SESSION_IDLE_TTL_MS: bad, MCP_SESSIONS_PER_USER: bad }), bad).toEqual({
        idleTtlMs: 3_600_000,
        perUser: 10,
      });
    }
  });
});
