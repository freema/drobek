import { describe, expect, it } from 'vitest';
import { WHATS_NEW_COOKIE, WHATS_NEW_MAX_AGE_SEC, dismissWhatsNew, loadWhatsNewBanner, whatsNewEnabled, whatsNewRedirect } from './whats-new.server.js';

const DEV_ENV = { NODE_ENV: 'development', PUBLIC_APP_URL: 'http://localhost:3041' } as NodeJS.ProcessEnv;
const PROD_ENV = { NODE_ENV: 'production', PUBLIC_APP_URL: 'https://drobek.example' } as NodeJS.ProcessEnv;

function req(cookie?: string): Request {
  return new Request('http://localhost:3041/workspaces', { headers: cookie ? { cookie } : {} });
}

const signedIn = async () => true;
const signedOut = async () => false;

describe('whatsNewEnabled', () => {
  it('is on by default and off for 0/off/false/no', () => {
    expect(whatsNewEnabled({})).toBe(true);
    expect(whatsNewEnabled({ WHATS_NEW_BANNER: '1' })).toBe(true);
    for (const v of ['0', 'off', 'false', 'no', ' OFF ']) expect(whatsNewEnabled({ WHATS_NEW_BANNER: v })).toBe(false);
  });
});

describe('loadWhatsNewBanner', () => {
  const env = { ...DEV_ENV, DROBEK_VERSION: 'v0.8.2' };

  it('shows the line to a signed-in person without a dismissal', async () => {
    expect(await loadWhatsNewBanner(req(), { env, signedIn })).toEqual({ line: '0.8' });
  });

  it('shows nothing to a signed-out visitor', async () => {
    expect(await loadWhatsNewBanner(req(), { env, signedIn: signedOut })).toBeNull();
  });

  it('respects the dismissal cookie of the current line and shows a newer one', async () => {
    expect(await loadWhatsNewBanner(req(`${WHATS_NEW_COOKIE}=0.8`), { env, signedIn })).toBeNull();
    expect(await loadWhatsNewBanner(req(`${WHATS_NEW_COOKIE}=0.7`), { env, signedIn })).toEqual({ line: '0.8' });
  });

  it('reads the __Host- cookie in production', async () => {
    const prod = { ...PROD_ENV, DROBEK_VERSION: 'v0.8.2' };
    expect(await loadWhatsNewBanner(req(`__Host-${WHATS_NEW_COOKIE}=0.8`), { env: prod, signedIn })).toBeNull();
    expect(await loadWhatsNewBanner(req(`${WHATS_NEW_COOKIE}=0.8`), { env: prod, signedIn })).toEqual({ line: '0.8' });
  });

  it('never looks up the session for a dev build or when turned off', async () => {
    const fail = async () => {
      throw new Error('must not be called');
    };
    expect(await loadWhatsNewBanner(req(), { env: { ...DEV_ENV, DROBEK_VERSION: 'dev' }, signedIn: fail })).toBeNull();
    expect(await loadWhatsNewBanner(req(), { env: { ...env, WHATS_NEW_BANNER: '0' }, signedIn: fail })).toBeNull();
  });

  it('hides the notice when the session store fails', async () => {
    const broken = async () => {
      throw new Error('redis down');
    };
    expect(await loadWhatsNewBanner(req(), { env, signedIn: broken })).toBeNull();
  });
});

describe('whatsNewRedirect', () => {
  it('redirects to the running tag, or the releases list for dev', () => {
    const tagged = whatsNewRedirect({ DROBEK_VERSION: 'v0.8.2' });
    expect(tagged.status).toBe(302);
    expect(tagged.headers.get('location')).toBe('https://github.com/freema/drobek/releases/tag/v0.8.2');
    expect(whatsNewRedirect({}).headers.get('location')).toBe('https://github.com/freema/drobek/releases');
  });
});

describe('dismissWhatsNew', () => {
  function post(body: Record<string, string>): Request {
    return new Request('http://localhost:3041/whats-new/dismiss', { method: 'POST', body: new URLSearchParams(body) });
  }

  it('sets the current line and returns to the page', async () => {
    const res = await dismissWhatsNew(post({ redirectTo: '/workspaces/acme/apps?q=x' }), { ...DEV_ENV, DROBEK_VERSION: 'v0.8.2' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/workspaces/acme/apps?q=x');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${WHATS_NEW_COOKIE}=0.8`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain(`Max-Age=${WHATS_NEW_MAX_AGE_SEC}`);
    expect(cookie).not.toContain('Secure');
  });

  it('sets a Secure __Host- cookie in production', async () => {
    const res = await dismissWhatsNew(post({ redirectTo: '/me' }), { ...PROD_ENV, DROBEK_VERSION: 'v0.8.2' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie.startsWith(`__Host-${WHATS_NEW_COOKIE}=0.8`)).toBe(true);
    expect(cookie).toContain('Secure');
  });

  it('never redirects off-site', async () => {
    for (const to of ['https://evil.example/', '//evil.example', '/\\evil.example', '']) {
      const res = await dismissWhatsNew(post({ redirectTo: to }), { ...DEV_ENV, DROBEK_VERSION: 'v0.8.2' });
      expect(res.headers.get('location')).toBe('/');
    }
  });

  it('sets no cookie for a dev build', async () => {
    const res = await dismissWhatsNew(post({ redirectTo: '/me' }), { ...DEV_ENV, DROBEK_VERSION: 'dev' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('location')).toBe('/me');
  });
});
