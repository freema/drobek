import { describe, expect, it } from 'vitest';
import { decideVisibility } from './visibility.js';

describe('decideVisibility', () => {
  it('public apps are always served', () => {
    expect(decideVisibility({ visibility: 'public', hasAppAccess: false })).toEqual({ action: 'serve' });
  });

  it('password apps need a valid app-access cookie', () => {
    expect(decideVisibility({ visibility: 'password', hasAppAccess: false })).toEqual({ action: 'password' });
    expect(decideVisibility({ visibility: 'password', hasAppAccess: true })).toEqual({ action: 'serve' });
  });

  it('fails closed on an unknown visibility value', () => {
    expect(decideVisibility({ visibility: 'team' as never, hasAppAccess: false })).toEqual({ action: 'password' });
  });
});
