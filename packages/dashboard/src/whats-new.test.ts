import { describe, expect, it } from 'vitest';
import { compareLines, parseLine, releaseLineOf, whatsNewLine, whatsNewTarget } from './whats-new.js';

describe('release lines', () => {
  it('reads major.minor from a release version', () => {
    expect(releaseLineOf('v0.8.3')).toEqual({ major: 0, minor: 8 });
    expect(releaseLineOf('1.12.0')).toEqual({ major: 1, minor: 12 });
    expect(releaseLineOf(' v0.9.0-rc.1 ')).toEqual({ major: 0, minor: 9 });
  });

  it('has no line for dev or anything unparsable', () => {
    for (const v of ['dev', '', null, undefined, 'v0.8', 'latest', 'v0.8.x', '0.8.1 extra', 'v0.8.1;x']) {
      expect(releaseLineOf(v)).toBeNull();
    }
  });

  it('compares lines numerically, not as text', () => {
    expect(compareLines({ major: 0, minor: 10 }, { major: 0, minor: 9 })).toBeGreaterThan(0);
    expect(compareLines({ major: 0, minor: 9 }, { major: 1, minor: 0 })).toBeLessThan(0);
    expect(compareLines({ major: 0, minor: 8 }, { major: 0, minor: 8 })).toBe(0);
  });

  it('parses a dismissal value only in the major.minor form', () => {
    expect(parseLine('0.8')).toEqual({ major: 0, minor: 8 });
    expect(parseLine('v0.8')).toBeNull();
    expect(parseLine('0.8.1')).toBeNull();
    expect(parseLine('')).toBeNull();
  });
});

describe('whatsNewLine', () => {
  const on = { enabled: true };

  it('announces the current line without a dismissal', () => {
    expect(whatsNewLine({ ...on, version: 'v0.8.0', dismissed: null })).toBe('0.8');
  });

  it('announces it when an older line was dismissed', () => {
    expect(whatsNewLine({ ...on, version: 'v0.10.2', dismissed: '0.9' })).toBe('0.10');
    expect(whatsNewLine({ ...on, version: 'v1.0.0', dismissed: '0.12' })).toBe('1.0');
  });

  it('stays hidden once the current or a newer line was dismissed', () => {
    expect(whatsNewLine({ ...on, version: 'v0.8.4', dismissed: '0.8' })).toBeNull();
    expect(whatsNewLine({ ...on, version: 'v0.8.4', dismissed: '0.9' })).toBeNull();
  });

  it('ignores a malformed dismissal', () => {
    expect(whatsNewLine({ ...on, version: 'v0.8.0', dismissed: 'garbage' })).toBe('0.8');
  });

  it('shows nothing for a dev build or when turned off', () => {
    expect(whatsNewLine({ ...on, version: 'dev', dismissed: null })).toBeNull();
    expect(whatsNewLine({ ...on, version: undefined, dismissed: null })).toBeNull();
    expect(whatsNewLine({ enabled: false, version: 'v0.8.0', dismissed: null })).toBeNull();
  });
});

describe('whatsNewTarget', () => {
  it('links the exact running tag', () => {
    expect(whatsNewTarget('v0.8.1')).toBe('https://github.com/freema/drobek/releases/tag/v0.8.1');
    expect(whatsNewTarget('0.8.1')).toBe('https://github.com/freema/drobek/releases/tag/v0.8.1');
    expect(whatsNewTarget('v0.9.0-rc.1')).toBe('https://github.com/freema/drobek/releases/tag/v0.9.0-rc.1');
  });

  it('links the releases list for a dev build', () => {
    expect(whatsNewTarget('dev')).toBe('https://github.com/freema/drobek/releases');
    expect(whatsNewTarget(undefined)).toBe('https://github.com/freema/drobek/releases');
  });
});
