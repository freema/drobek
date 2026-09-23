import { describe, expect, it } from 'vitest';
import { checkHostname, cnameTarget, verificationRecordName, verificationRecordValue, type HostnameRules } from './hostname.js';

const PROD: HostnameRules = { appsDomain: 'drobek.app', dashboardHost: 'drobek.app' };
const SELF: HostnameRules = { appsDomain: 'apps.firma.cz', dashboardHost: 'drobek.firma.cz:8443' };
const DEV_MOCK: HostnameRules = { appsDomain: 'apps.localhost:3041', dashboardHost: 'localhost:3041', allowTestTld: true };

function ok(raw: string, rules = PROD): string {
  const r = checkHostname(raw, rules);
  if (!r.ok) throw new Error(`${raw}: ${r.message}`);
  return r.hostname;
}

function code(raw: unknown, rules = PROD): string | null {
  const r = checkHostname(raw, rules);
  return r.ok ? null : r.code;
}

describe('checkHostname — accepted names are normalised', () => {
  it('registrable domains and their subdomains', () => {
    expect(ok('firma.cz')).toBe('firma.cz');
    expect(ok('www.firma.cz')).toBe('www.firma.cz');
    expect(ok('a.b.co.uk')).toBe('a.b.co.uk');
    expect(ok('x.github.io')).toBe('x.github.io');
  });

  it('case, whitespace, a trailing dot and a pasted URL', () => {
    expect(ok('  Shop.Firma.CZ.  ')).toBe('shop.firma.cz');
    expect(ok('https://shop.firma.cz/')).toBe('shop.firma.cz');
    expect(ok('shop.firma.cz/')).toBe('shop.firma.cz');
  });

  it('IDNA → ASCII', () => {
    expect(ok('bücher.de')).toBe('xn--bcher-kva.de');
    expect(ok('xn--bcher-kva.de')).toBe('xn--bcher-kva.de');
  });
});

describe('checkHostname — refusals', () => {
  it('drobek-owned names: drobek.app, APPS_DOMAIN and the dashboard host (and below)', () => {
    expect(code('www.drobek.app')).toBe('hostname_not_allowed');
    expect(code('drobek.app')).toBe('hostname_not_allowed');
    expect(code('shop.drobek.app')).toBe('hostname_not_allowed');
    // drobek.app stays refused on any instance, whatever its own domains are.
    expect(code('www.drobek.app', SELF)).toBe('hostname_not_allowed');
    expect(code('shop.apps.firma.cz', SELF)).toBe('hostname_not_allowed');
    expect(code('apps.firma.cz', SELF)).toBe('hostname_not_allowed');
    expect(code('drobek.firma.cz', SELF)).toBe('hostname_not_allowed');
    expect(code('x.drobek.firma.cz', SELF)).toBe('hostname_not_allowed');
    // …but a sibling of them is a customer's own name.
    expect(ok('shop.firma.cz', SELF)).toBe('shop.firma.cz');
  });

  it('IP literals', () => {
    for (const raw of ['1.2.3.4', '10.0.0.1', '::1', '[::1]', '2001:db8::1', '127.1']) {
      expect(code(raw), raw).toBe('invalid_hostname');
    }
  });

  it('bare public suffixes and unlisted TLDs (PSL)', () => {
    expect(code('co.uk')).toBe('hostname_not_allowed');
    expect(code('github.io')).toBe('hostname_not_allowed');
    expect(code('firma.notatld')).toBe('hostname_not_allowed');
  });

  it('special-use names; .test only with the dev DNS mock', () => {
    for (const raw of ['localhost', 'x.localhost', 'printer.local', 'db.internal', 'a.example', 'firma.test']) {
      expect(code(raw), raw).not.toBeNull();
    }
    expect(ok('firma.test', DEV_MOCK)).toBe('firma.test');
    expect(code('x.localhost', DEV_MOCK)).toBe('hostname_not_allowed');
    expect(code('shop.apps.localhost', DEV_MOCK)).toBe('hostname_not_allowed');
  });

  it('malformed input', () => {
    for (const raw of [
      '',
      '   ',
      'firma',
      'firma.cz:8443',
      'https://firma.cz:8443/',
      'https://firma.cz/path',
      'https://user@firma.cz/',
      'firma.cz/path',
      'fir ma.cz',
      '-firma.cz',
      'firma-.cz',
      'fir_ma.cz',
      'a..cz',
      `${'a'.repeat(64)}.cz`,
      `${'a.'.repeat(130)}cz`,
    ]) {
      expect(code(raw), raw).toBe('invalid_hostname');
    }
    expect(code(42)).toBe('invalid_hostname');
    expect(code(null)).toBe('invalid_hostname');
  });
});

describe('DNS record helpers', () => {
  it('names the TXT record, its value and the CNAME target (port dropped)', () => {
    expect(verificationRecordName('shop.firma.cz')).toBe('_drobek.shop.firma.cz');
    expect(verificationRecordValue('abc')).toBe('drobek-verify=abc');
    expect(cnameTarget('shop', 'drobek.app')).toBe('shop.drobek.app');
    expect(cnameTarget('shop', 'apps.localhost:3041')).toBe('shop.apps.localhost');
  });
});
