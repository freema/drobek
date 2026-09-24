import { describe, expect, it } from 'vitest';
import { headers } from './report.server.js';

describe('report route headers (M4-02)', () => {
  it('passes the action headers through so a 429 keeps its Retry-After', () => {
    const actionHeaders = new Headers({ 'Retry-After': '3600' });
    const out = headers({
      actionHeaders,
      loaderHeaders: new Headers(),
      parentHeaders: new Headers(),
      errorHeaders: undefined,
    });
    expect(new Headers(out).get('Retry-After')).toBe('3600');
  });
});
