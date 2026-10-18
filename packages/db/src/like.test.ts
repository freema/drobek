import { describe, expect, it } from 'vitest';
import { containsPattern } from './like.js';

describe('containsPattern', () => {
  it('escapes the LIKE wildcards and the escape character', () => {
    expect(containsPattern('acme')).toBe('%acme%');
    expect(containsPattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });
});
