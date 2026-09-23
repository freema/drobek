import { describe, expect, it } from 'vitest';
import { resolveRecipients, sanitizeSubject } from './email.js';

const user = { kind: 'user' as const, id: 'u', email: 'ana@example.com', role: 'user' as const };

describe('module e-mail recipients', () => {
  it('config paths, the principal, and (auth) one sign-in address — nothing else', () => {
    const config = { notify: { emails: ['a@b.cz', 'not-an-address', 'c@d.cz'] } };
    expect(resolveRecipients({ config: 'notify.emails' }, user, config)).toEqual(['a@b.cz', 'c@d.cz']);
    expect(resolveRecipients({ principal: true }, user, config)).toEqual(['ana@example.com']);
    expect(() => resolveRecipients({ principal: true }, { kind: 'anon' }, config)).toThrow(/Sign in/);
    expect(resolveRecipients({ signInAddress: ' x@firma.cz ' }, { kind: 'anon' }, config)).toEqual(['x@firma.cz']);
    for (const bad of ['a@b.cz, c@d.cz', 'a@b.cz\r\nBcc: e@f.cz', 'x', `${'a'.repeat(250)}@b.cz`]) {
      expect(resolveRecipients({ signInAddress: bad }, { kind: 'anon' }, config)).toEqual([]);
    }
  });

  it('subjects are one line (no header injection), capped at 200', () => {
    expect(sanitizeSubject('Hi\r\nBcc: evil@example.com\tthere')).toBe('Hi Bcc: evil@example.com there');
    expect(sanitizeSubject(`a${String.fromCharCode(0x2028)}b`)).toBe('a b');
    expect(sanitizeSubject('x'.repeat(300))).toHaveLength(200);
  });
});
