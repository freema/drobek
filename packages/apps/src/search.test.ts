import { describe, expect, it } from 'vitest';
import { foldSearchText, matchesSearch, searchLikePattern } from './search.js';

describe('matchesSearch', () => {
  const fields = ['podzimn-obloha', 'Podzimní obloha'];

  it('ignores accents and case in the query and the fields', () => {
    for (const q of ['Podzimní', 'podzimni', 'PODZIMNI', 'podzimní'.normalize('NFD'), 'OBLOHA', 'zimn-obl']) {
      expect(matchesSearch(q, fields), q).toBe(true);
    }
    expect(matchesSearch('prilis zlutoucky', ['Příliš žluťoučký kůň'.normalize('NFD')])).toBe(true);
    expect(matchesSearch('jaro', fields)).toBe(false);
  });

  it('matches % and _ literally', () => {
    expect(matchesSearch('%', fields)).toBe(false);
    expect(matchesSearch('_', fields)).toBe(false);
    expect(matchesSearch('37%', ['Sleva 37% dnes'])).toBe(true);
    expect(matchesSearch('a_b', ['a_b app'])).toBe(true);
    expect(matchesSearch('a_b', ['axb app'])).toBe(false);
  });

  it('treats an empty query as no filter and skips missing fields', () => {
    expect(matchesSearch('  ', [null])).toBe(true);
    expect(matchesSearch('x', [null, undefined])).toBe(false);
  });
});

describe('foldSearchText / searchLikePattern', () => {
  it('folds composed and decomposed input to the same text', () => {
    expect(foldSearchText('Podzimní')).toBe('podzimni');
    expect(foldSearchText('Podzimní'.normalize('NFD'))).toBe('podzimni');
  });

  it('escapes LIKE wildcards and the escape character', () => {
    expect(searchLikePattern('Podzimní')).toBe('%podzimni%');
    expect(searchLikePattern('100%')).toBe('%100\\%%');
    expect(searchLikePattern('a_b')).toBe('%a\\_b%');
    expect(searchLikePattern('c:\\x')).toBe('%c:\\\\x%');
  });
});
