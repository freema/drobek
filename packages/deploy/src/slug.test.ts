import { describe, expect, it } from 'vitest';
import { deriveSlug, slugCandidate } from './slug.js';

describe('deriveSlug', () => {
  it('slugifies a human app name', () => {
    expect(deriveSlug('My Cool App!')).toBe('my-cool-app');
    expect(deriveSlug('Todo  List 2000')).toBe('todo-list-2000');
  });

  it('collapses dash runs and trims edges', () => {
    expect(deriveSlug('  --Hello__World--  ')).toBe('hello-world');
  });

  it('falls back to "app" when nothing usable remains', () => {
    expect(deriveSlug('***')).toBe('app');
    expect(deriveSlug('')).toBe('app');
  });

  it('truncates to the max length without a trailing dash', () => {
    const s = deriveSlug('a'.repeat(60));
    expect(s.length).toBeLessThanOrEqual(40);
  });
});

describe('slugCandidate', () => {
  it('returns the base for attempt 0 and a numeric suffix after', () => {
    expect(slugCandidate('todo', 0)).toBe('todo');
    expect(slugCandidate('todo', 1)).toBe('todo-2');
    expect(slugCandidate('todo', 4)).toBe('todo-5');
  });
});
