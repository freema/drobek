import { describe, expect, it } from 'vitest';
import { APP_SLUG_MAX, deriveSlug, suggestSlug, validateAppSlug } from './slug.js';

describe('app slugs', () => {
  it.each([
    ['todo', null],
    ['crm-lite-2', null],
    ['ab', 'must be 3–40 characters'],
    ['a'.repeat(41), 'must be 3–40 characters'],
    ['my--app', 'may only contain'],
    ['-app', 'may only contain'],
    ['App', 'may only contain'],
    ['mcp', 'is reserved'],
    ['oauth', 'is reserved'],
  ])('validateAppSlug(%s)', (slug, reason) => {
    const out = validateAppSlug(slug);
    if (reason === null) expect(out).toBeNull();
    else expect(out).toContain(reason);
  });

  it('derives slug grammar from a name', () => {
    expect(deriveSlug('  My Todo App!! ')).toBe('my-todo-app');
    expect(deriveSlug('a--b__c')).toBe('a-b-c');
    expect(deriveSlug('x'.repeat(60))).toHaveLength(APP_SLUG_MAX);
  });

  it('suggests <slug>-<4hex> within the length limit', () => {
    expect(suggestSlug('todo', 'beef')).toBe('todo-beef');
    const long = suggestSlug('a'.repeat(40), 'cafe');
    expect(long).toHaveLength(APP_SLUG_MAX);
    expect(validateAppSlug(long)).toBeNull();
  });
});
