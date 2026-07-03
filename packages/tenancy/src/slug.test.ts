import { describe, expect, it } from 'vitest';
import {
  RESERVED_SLUGS,
  SLUG_MAX,
  personalSlugBase,
  personalSlugCandidate,
  validateTeamSlug,
} from './slug.js';

describe('validateTeamSlug', () => {
  it('accepts [a-z0-9-] between 3 and 40 chars', () => {
    expect(validateTeamSlug('acme')).toBeNull();
    expect(validateTeamSlug('a-1')).toBeNull();
    expect(validateTeamSlug('x'.repeat(40))).toBeNull();
  });

  it('rejects too-short, too-long, bad charset', () => {
    expect(validateTeamSlug('ab')).not.toBeNull();
    expect(validateTeamSlug('x'.repeat(41))).not.toBeNull();
    expect(validateTeamSlug('Acme')).not.toBeNull();
    expect(validateTeamSlug('acme crew')).not.toBeNull();
    expect(validateTeamSlug('ácme')).not.toBeNull();
    expect(validateTeamSlug('')).not.toBeNull();
  });

  it('rejects every reserved slug', () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(validateTeamSlug(reserved)).not.toBeNull();
    }
    // …including the ones a route would collide with.
    expect(validateTeamSlug('workspaces')).not.toBeNull();
    expect(validateTeamSlug('invite')).not.toBeNull();
    expect(validateTeamSlug('healthz')).not.toBeNull();
  });
});

describe('personalSlugBase (sanitized email local-part)', () => {
  it('lowercases and keeps [a-z0-9-]', () => {
    expect(personalSlugBase('Tomas.Grasl@example.com')).toBe('tomas-grasl');
    expect(personalSlugBase('user123@example.com')).toBe('user123');
  });

  it('collapses non-alphanumeric runs into single dashes and trims edges', () => {
    expect(personalSlugBase('a__b..c@example.com')).toBe('a-b-c');
    expect(personalSlugBase('-weird-@example.com')).toBe('weird');
    expect(personalSlugBase('e2e+tag@example.com')).toBe('e2e-tag');
  });

  it('pads short local-parts to the 3-char minimum', () => {
    expect(personalSlugBase('ab@example.com')).toBe('ws-ab');
    expect(personalSlugBase('a@example.com')).toBe('ws-a');
  });

  it('falls back when the local-part sanitizes to nothing', () => {
    expect(personalSlugBase('...@example.com')).toBe('workspace');
  });

  it('truncates long local-parts leaving room for a collision suffix', () => {
    const base = personalSlugBase(`${'x'.repeat(60)}@example.com`);
    expect(base.length).toBeLessThanOrEqual(SLUG_MAX - 4);
    expect(base).toBe('x'.repeat(SLUG_MAX - 4));
  });

  it('nudges reserved names off the reserved list', () => {
    expect(personalSlugBase('admin@example.com')).toBe('admin-ws');
    expect(personalSlugBase('api@example.com')).toBe('api-ws');
    expect(RESERVED_SLUGS.has(personalSlugBase('me@example.com'))).toBe(false);
  });

  it('candidates append a numeric suffix on collision and stay <= 40 chars', () => {
    const base = personalSlugBase(`${'y'.repeat(60)}@example.com`);
    expect(personalSlugCandidate(base, 0)).toBe(base);
    expect(personalSlugCandidate(base, 1)).toBe(`${base}-2`);
    expect(personalSlugCandidate(base, 9)).toBe(`${base}-10`);
    expect(personalSlugCandidate(base, 9).length).toBeLessThanOrEqual(SLUG_MAX);
  });
});
