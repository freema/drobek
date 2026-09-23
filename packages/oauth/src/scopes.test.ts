import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOPES,
  SCOPES,
  TOOL_SCOPES,
  allowedTools,
  hasScope,
  knownScopes,
  parseScopes,
  toolAllowed,
  type Scope,
} from './scopes.js';

describe('parseScopes (a REQUESTED scope)', () => {
  it('keeps only known scopes, deduped, in vocabulary order', () => {
    expect(parseScopes('write read read bogus')).toEqual(['read', 'write']);
  });

  it('falls back to the default offer when the request names no scope', () => {
    expect(parseScopes('')).toEqual([...DEFAULT_SCOPES]);
    expect(parseScopes(null)).toEqual([...DEFAULT_SCOPES]);
    expect(DEFAULT_SCOPES).toEqual(['read', 'write']);
  });

  it('returns nothing for a request that names only unknown scopes (→ invalid_scope)', () => {
    expect(parseScopes('apps:read data:write')).toEqual([]);
  });
});

describe('knownScopes / hasScope (a GRANTED scope)', () => {
  it('never invents a default for a stored grant', () => {
    expect(knownScopes('')).toEqual([]);
    expect(knownScopes('publish read mcp:whoami')).toEqual(['read', 'publish']);
  });

  it('detects a granted scope in a space-delimited string', () => {
    expect(hasScope('read write', 'write')).toBe(true);
    expect(hasScope('read', 'write')).toBe(false);
    expect(hasScope(null, 'read')).toBe(false);
  });
});

/** Every subset of the three scopes (2³ = 8 combinations). */
function allCombinations(): Scope[][] {
  const out: Scope[][] = [];
  for (let mask = 0; mask < 1 << SCOPES.length; mask++) {
    out.push(SCOPES.filter((_, i) => mask & (1 << i)));
  }
  return out;
}

const READ_TOOLS = ['list_apps', 'get_app', 'read_file', 'skill_info', 'query_data', 'get_logs'];
const WRITE_TOOLS = ['create_app', 'write_files', 'restore_version', 'configure_module'];
const PUBLISH_TOOLS = ['publish'];

/** The exact tools/list per combination, spelled out (not derived from the table). */
const EXPECTED: Record<string, string[]> = {
  '': [],
  read: [...READ_TOOLS],
  write: [...WRITE_TOOLS],
  publish: [...PUBLISH_TOOLS],
  'read write': [...READ_TOOLS, ...WRITE_TOOLS],
  'read publish': [...READ_TOOLS, ...PUBLISH_TOOLS],
  'write publish': [...WRITE_TOOLS, ...PUBLISH_TOOLS],
  'read write publish': [...READ_TOOLS, ...WRITE_TOOLS, ...PUBLISH_TOOLS],
};

describe('tool → scope table', () => {
  it('covers all 8 scope combinations', () => {
    expect(allCombinations().map((c) => c.join(' ')).sort()).toEqual(
      Object.keys(EXPECTED).sort()
    );
  });

  for (const combo of allCombinations()) {
    const key = combo.join(' ');
    it(`grant "${key || '(none)'}" lists exactly its tools`, () => {
      expect([...allowedTools(combo)].sort()).toEqual([...EXPECTED[key]].sort());
      // The wire form gives the same answer as the parsed form.
      expect([...allowedTools(key)].sort()).toEqual([...EXPECTED[key]].sort());
    });
  }

  it('every tool needs exactly one scope; publish unlocks exactly the publish tool', () => {
    for (const scope of Object.values(TOOL_SCOPES)) expect(['read', 'write', 'publish']).toContain(scope);
    expect(toolAllowed([], 'list_apps')).toBe(false);
    expect(toolAllowed(['read'], 'write_files')).toBe(false);
    expect(toolAllowed(['write'], 'read_file')).toBe(false);
    expect(toolAllowed('read', 'get_app')).toBe(true);
    expect(toolAllowed(['read', 'write'], 'publish')).toBe(false);
    expect(allowedTools(['publish'])).toEqual(['publish']);
  });
});
