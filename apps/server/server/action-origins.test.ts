import { describe, expect, it } from 'vitest';
import type { ServerBuild } from 'react-router';
import { withPublicActionOrigin } from './action-origins.js';

const build = (extra: Partial<ServerBuild> = {}) => ({ ...extra }) as ServerBuild;

describe('withPublicActionOrigin', () => {
  it('adds the host of PUBLIC_APP_URL to allowedActionOrigins', () => {
    const out = withPublicActionOrigin(build(), { PUBLIC_APP_URL: 'https://drobek.app' });
    expect(out.allowedActionOrigins).toEqual(['drobek.app']);
  });

  it('keeps the port of a non-default origin', () => {
    const out = withPublicActionOrigin(build(), { PUBLIC_APP_URL: 'https://localhost:8443/' });
    expect(out.allowedActionOrigins).toEqual(['localhost:8443']);
  });

  it('merges with origins the build already allows, without duplicates', () => {
    const out = withPublicActionOrigin(build({ allowedActionOrigins: ['a.example'] }), {
      PUBLIC_APP_URL: 'https://drobek.app',
    });
    expect(out.allowedActionOrigins).toEqual(['a.example', 'drobek.app']);
    const again = withPublicActionOrigin(out, { PUBLIC_APP_URL: 'https://drobek.app' });
    expect(again).toBe(out);
  });

  it('leaves the build alone without a valid PUBLIC_APP_URL', () => {
    const b = build();
    expect(withPublicActionOrigin(b, {})).toBe(b);
    expect(withPublicActionOrigin(b, { PUBLIC_APP_URL: 'not a url' })).toBe(b);
  });

  it('treats `false` (what a real build carries when nothing is configured) as an empty list', () => {
    const out = withPublicActionOrigin(build({ allowedActionOrigins: false }), {
      PUBLIC_APP_URL: 'https://drobek.app',
    });
    expect(out.allowedActionOrigins).toEqual(['drobek.app']);
  });
});
