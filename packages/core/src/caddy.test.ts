/**
 * Caddyfile generator (M0-07): strict env validation and one snapshot per TLS
 * mode. The snapshots in __snapshots__/ are also the reference examples that
 * docs/SELF-HOSTING.md points at.
 */
import { describe, expect, it } from 'vitest';
import { caddyConfigFromEnv, caddyfileFromEnv, isValidTlsAskToken } from './caddy.js';

const TOKEN = 'f'.repeat(64);
const PROD = {
  PUBLIC_APP_URL: 'https://drobek.app',
  APPS_DOMAIN: 'drobek.app',
} as NodeJS.ProcessEnv;

function render(env: NodeJS.ProcessEnv): string {
  const r = caddyfileFromEnv(env);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.caddyfile;
}

function errors(env: NodeJS.ProcessEnv): string[] {
  const r = caddyConfigFromEnv(env);
  return r.ok ? [] : r.errors;
}

describe('renderCaddyfile — one snapshot per TLS mode', () => {
  it('dev: tls internal on localhost + *.apps.localhost', async () => {
    const out = render({ PUBLIC_APP_URL: 'https://localhost', APPS_DOMAIN: 'apps.localhost', TLS_INTERNAL: '1' });
    await expect(out).toMatchFileSnapshot('./__snapshots__/Caddyfile.internal');
  });

  it('(a) wildcard certificate files', async () => {
    const out = render({
      ...PROD,
      TLS_WILDCARD_CERT_FILE: '/certs/wildcard.crt',
      TLS_WILDCARD_KEY_FILE: '/certs/wildcard.key',
      TLS_ACME_EMAIL: 'ops@example.com',
    });
    await expect(out).toMatchFileSnapshot('./__snapshots__/Caddyfile.wildcard-file');
  });

  it('(b) DNS-01 with a provider module + CNAME delegation', async () => {
    const out = render({
      ...PROD,
      TLS_DNS_PROVIDER: 'cloudflare',
      TLS_DNS_PROVIDER_ARGS: '{env.DNS_API_TOKEN}',
      TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN: '_acme-challenge.acme-delegate.example.net.',
      TLS_ACME_EMAIL: 'ops@example.com',
    });
    await expect(out).toMatchFileSnapshot('./__snapshots__/Caddyfile.dns');
  });

  it('(c) on-demand per host, always behind the ask endpoint', async () => {
    const out = render({ ...PROD, TLS_ASK_TOKEN: TOKEN, TLS_ACME_EMAIL: 'ops@example.com' });
    await expect(out).toMatchFileSnapshot('./__snapshots__/Caddyfile.on-demand');
  });
});

describe('proxy + secret invariants (every mode)', () => {
  const modes: NodeJS.ProcessEnv[] = [
    { PUBLIC_APP_URL: 'https://localhost', APPS_DOMAIN: 'apps.localhost', TLS_INTERNAL: 'true' },
    { ...PROD, TLS_WILDCARD_CERT_FILE: '/certs/w.crt', TLS_WILDCARD_KEY_FILE: '/certs/w.key' },
    { ...PROD, TLS_DNS_PROVIDER: 'cloudflare', TLS_DNS_PROVIDER_ARGS: '{env.DNS_API_TOKEN}' },
    { ...PROD, TLS_ASK_TOKEN: TOKEN },
  ];

  it('sets X-Real-IP from the peer, blocks /api/internal, never rewrites Host', () => {
    for (const env of modes) {
      const out = render(env);
      expect(out).toContain('header_up X-Real-IP {remote_host}');
      expect(out).toMatch(/@internal path \/api\/internal \/api\/internal\/\*\n\thandle @internal \{\n\t\trespond 404/);
      expect(out).not.toMatch(/header_up\s+Host/i);
      expect(out).not.toContain('trusted_proxies');
    }
  });

  it('never writes the ask token (or any env secret) into the file', () => {
    for (const env of modes) expect(render(env)).not.toContain(TOKEN);
  });

  it('on_demand appears only together with the ask guard', () => {
    for (const env of modes) {
      const out = render(env);
      if (out.includes('on_demand')) {
        expect(out).toContain('ask http://drobek:3000/api/internal/tls/ask?token={$TLS_ASK_TOKEN}');
      }
    }
    expect(render(modes[0])).not.toContain('on_demand');
    expect(render(modes[1])).not.toContain('on_demand');
    expect(render(modes[2])).not.toContain('on_demand');
  });

  it('a custom upstream and a non-443 port are carried into the site addresses', () => {
    const out = render({
      PUBLIC_APP_URL: 'https://localhost:8443',
      APPS_DOMAIN: 'apps.localhost:8443',
      TLS_INTERNAL: '1',
      DROBEK_UPSTREAM: 'app:4000',
    });
    expect(out).toContain('\nlocalhost:8443 {\n');
    expect(out).toContain('\n*.apps.localhost:8443 {\n');
    expect(out).toContain('reverse_proxy app:4000 {');
  });

  it('APPS_DOMAIN with :443 is the bare host', () => {
    expect(render({ ...PROD, APPS_DOMAIN: 'drobek.app:443', TLS_ASK_TOKEN: TOKEN })).toContain('\n*.drobek.app {\n');
  });
});

describe('caddyConfigFromEnv — strict validation', () => {
  it('requires PUBLIC_APP_URL (https, bare origin) and APPS_DOMAIN', () => {
    expect(errors({ TLS_INTERNAL: '1' }).join('\n')).toMatch(/PUBLIC_APP_URL is not set[\s\S]*APPS_DOMAIN is not set/);
    expect(errors({ ...PROD, PUBLIC_APP_URL: 'http://drobek.app', TLS_INTERNAL: '1' })).toEqual([
      'PUBLIC_APP_URL must be an https:// URL when Caddy terminates TLS',
    ]);
    expect(errors({ ...PROD, PUBLIC_APP_URL: 'https://drobek.app/x', TLS_INTERNAL: '1' })[0]).toMatch(/bare origin/);
    expect(errors({ ...PROD, PUBLIC_APP_URL: 'https://10.0.0.1', TLS_INTERNAL: '1' })[0]).toMatch(/DNS host/);
    expect(errors({ ...PROD, APPS_DOMAIN: 'https://drobek.app', TLS_INTERNAL: '1' })[0]).toMatch(/bare host name/);
    expect(errors({ ...PROD, APPS_URL_SCHEME: 'http', TLS_INTERNAL: '1' })[0]).toMatch(/APPS_URL_SCHEME must be https/);
  });

  it('refuses ambiguous TLS combinations', () => {
    const wild = { TLS_WILDCARD_CERT_FILE: '/certs/w.crt', TLS_WILDCARD_KEY_FILE: '/certs/w.key' };
    expect(errors({ ...PROD, ...wild, TLS_DNS_PROVIDER: 'cloudflare' }).join()).toMatch(
      /ambiguous TLS configuration: set only one of TLS_WILDCARD_CERT_FILE, TLS_DNS_PROVIDER/
    );
    expect(errors({ ...PROD, ...wild, TLS_INTERNAL: '1' }).join()).toMatch(/ambiguous/);
    expect(errors({ ...PROD, TLS_DNS_PROVIDER: 'cloudflare', TLS_INTERNAL: '1' }).join()).toMatch(/ambiguous/);
  });

  it('wildcard files: both or neither, absolute, no Caddyfile metacharacters', () => {
    expect(errors({ ...PROD, TLS_WILDCARD_CERT_FILE: '/certs/w.crt' })).toContain(
      'TLS_WILDCARD_CERT_FILE and TLS_WILDCARD_KEY_FILE must be set together'
    );
    expect(errors({ ...PROD, TLS_WILDCARD_CERT_FILE: 'w.crt', TLS_WILDCARD_KEY_FILE: '/certs/w.key' })[0]).toMatch(/absolute/);
    expect(
      errors({ ...PROD, TLS_WILDCARD_CERT_FILE: '/certs/w.crt }\nimport x', TLS_WILDCARD_KEY_FILE: '/certs/w.key' })[0]
    ).toMatch(/absolute/);
  });

  it('DNS provider: a module name, placeholder/plain args only, override needs a provider', () => {
    expect(errors({ ...PROD, TLS_DNS_PROVIDER: 'cloud flare' })[0]).toMatch(/provider name/);
    expect(errors({ ...PROD, TLS_DNS_PROVIDER: 'cloudflare', TLS_DNS_PROVIDER_ARGS: 'tok}\n}' })[0]).toMatch(
      /TLS_DNS_PROVIDER_ARGS/
    );
    expect(errors({ ...PROD, TLS_DNS_PROVIDER_ARGS: '{env.X}' })[0]).toMatch(/need TLS_DNS_PROVIDER/);
    expect(errors({ ...PROD, TLS_DNS_PROVIDER: 'cloudflare', TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN: 'bad domain' })[0]).toMatch(
      /OVERRIDE_DOMAIN/
    );
  });

  it('on-demand (the fallback) refuses to render without a valid TLS_ASK_TOKEN', () => {
    expect(errors(PROD)[0]).toMatch(/on-demand TLS .* needs TLS_ASK_TOKEN/);
    expect(errors({ ...PROD, TLS_ASK_TOKEN: 'short' })[0]).toMatch(/needs TLS_ASK_TOKEN/);
    expect(errors({ ...PROD, TLS_ASK_TOKEN: TOKEN })).toEqual([]);
  });

  it('rejects a bad TLS_INTERNAL, e-mail and upstream', () => {
    expect(errors({ ...PROD, TLS_INTERNAL: 'maybe', TLS_ASK_TOKEN: TOKEN })[0]).toMatch(/TLS_INTERNAL/);
    expect(errors({ ...PROD, TLS_ASK_TOKEN: TOKEN, TLS_ACME_EMAIL: 'x y@z' })[0]).toMatch(/TLS_ACME_EMAIL/);
    expect(errors({ ...PROD, TLS_ASK_TOKEN: TOKEN, DROBEK_UPSTREAM: 'drobek' })[0]).toMatch(/DROBEK_UPSTREAM/);
    expect(errors({ ...PROD, TLS_INTERNAL: '1', TLS_ACME_EMAIL: 'ops@example.com' })[0]).toMatch(/no effect/);
  });
});

describe('isValidTlsAskToken', () => {
  it('needs 32+ URL-safe characters', () => {
    expect(isValidTlsAskToken(TOKEN)).toBe(true);
    expect(isValidTlsAskToken('a'.repeat(31))).toBe(false);
    expect(isValidTlsAskToken(`${'a'.repeat(32)}&x=1`)).toBe(false);
    expect(isValidTlsAskToken(undefined)).toBe(false);
  });
});
