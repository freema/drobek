import { describe, expect, it } from 'vitest';
import { checkDomainDns, dnsMockKey, redisDnsMock, type DnsResolver } from './dns.js';

const INPUT = { hostname: 'shop.firma.cz', token: 'tok123', cnameTarget: 'shop.drobek.app' };

type Zone = Partial<Record<'txt' | 'cname' | 'a' | 'aaaa', Record<string, string[] | 'SERVFAIL' | 'HANG'>>>;

/** A resolver over an in-memory zone; missing = ENODATA, 'SERVFAIL' = ESERVFAIL, 'HANG' never answers. */
function fake(zone: Zone): DnsResolver {
  const read = (type: keyof Zone, name: string): Promise<string[]> => {
    const v = zone[type]?.[name];
    if (v === 'HANG') return new Promise(() => undefined);
    if (v === 'SERVFAIL') return Promise.reject(Object.assign(new Error('servfail'), { code: 'ESERVFAIL' }));
    if (v === undefined) return Promise.reject(Object.assign(new Error('nodata'), { code: 'ENODATA' }));
    return Promise.resolve(v);
  };
  return {
    resolveTxt: async (n) => (await read('txt', n)).map((s) => [s.slice(0, 5), s.slice(5)]),
    resolveCname: (n) => read('cname', n),
    resolve4: (n) => read('a', n),
    resolve6: (n) => read('aaaa', n),
  };
}

const GOOD_TXT = { '_drobek.shop.firma.cz': ['v=spf1 -all', 'drobek-verify=tok123'] };

describe('checkDomainDns', () => {
  it('both records → ok (TXT chunks are concatenated, CNAME case/dot-insensitive)', async () => {
    const r = await checkDomainDns(fake({ txt: GOOD_TXT, cname: { 'shop.firma.cz': ['Shop.Drobek.App.'] } }), INPUT);
    expect(r).toEqual({ ok: true, transient: false, txt: 'ok', target: 'ok', error: null });
  });

  it('no TXT → definitive failure naming the record', async () => {
    const r = await checkDomainDns(fake({ cname: { 'shop.firma.cz': ['shop.drobek.app'] } }), INPUT);
    expect(r).toMatchObject({ ok: false, transient: false, txt: 'missing', target: 'ok' });
    expect(r.error).toContain('_drobek.shop.firma.cz');
  });

  it('a TXT with another token, a CNAME elsewhere → wrong', async () => {
    const r = await checkDomainDns(
      fake({ txt: { '_drobek.shop.firma.cz': ['drobek-verify=other'] }, cname: { 'shop.firma.cz': ['elsewhere.example.net'] } }),
      INPUT
    );
    expect(r).toMatchObject({ ok: false, transient: false, txt: 'wrong', target: 'wrong' });
  });

  it('apex without a CNAME: the same addresses as the app host pass (ALIAS / flattening)', async () => {
    const zone: Zone = {
      txt: GOOD_TXT,
      a: { 'shop.firma.cz': ['203.0.113.7'], 'shop.drobek.app': ['203.0.113.7', '203.0.113.8'] },
    };
    expect((await checkDomainDns(fake(zone), INPUT)).ok).toBe(true);
    zone.a!['shop.firma.cz'] = ['198.51.100.1'];
    expect(await checkDomainDns(fake(zone), INPUT)).toMatchObject({ ok: false, target: 'wrong', transient: false });
  });

  it('SERVFAIL / timeout → transient (an existing verification is kept)', async () => {
    const r = await checkDomainDns(fake({ txt: { '_drobek.shop.firma.cz': 'SERVFAIL' }, cname: { 'shop.firma.cz': ['shop.drobek.app'] } }), INPUT);
    expect(r).toMatchObject({ ok: false, transient: true, txt: 'unavailable', target: 'ok' });
    const t = await checkDomainDns(
      fake({ txt: GOOD_TXT, cname: { 'shop.firma.cz': 'HANG' }, a: { 'shop.firma.cz': 'HANG' } }),
      INPUT,
      { timeoutMs: 20 }
    );
    expect(t).toMatchObject({ ok: false, transient: true, txt: 'ok', target: 'unavailable' });
  });

  it('a definitive miss wins over a transient one', async () => {
    const r = await checkDomainDns(fake({ cname: { 'shop.firma.cz': 'SERVFAIL' } }), INPUT);
    expect(r).toMatchObject({ ok: false, transient: false, txt: 'missing' });
  });
});

describe('redisDnsMock', () => {
  it('answers from drobek:dns-mock:<type>:<name> keys', async () => {
    const store = new Map<string, string>([
      [dnsMockKey('txt', '_drobek.firma.test'), JSON.stringify(['drobek-verify=abc'])],
      [dnsMockKey('cname', 'FIRMA.test.'), JSON.stringify(['shop.apps.localhost'])],
      [dnsMockKey('a', 'broken.test'), JSON.stringify('SERVFAIL')],
    ]);
    const mock = redisDnsMock(() => ({ get: async (k: string) => store.get(k) ?? null }));
    expect(await mock.resolveTxt('_drobek.firma.test')).toEqual([['drobek-verify=abc']]);
    expect(await mock.resolveCname('firma.test')).toEqual(['shop.apps.localhost']);
    await expect(mock.resolve4('firma.test')).rejects.toMatchObject({ code: 'ENODATA' });
    await expect(mock.resolve4('broken.test')).rejects.toMatchObject({ code: 'ESERVFAIL' });
    const r = await checkDomainDns(mock, { hostname: 'firma.test', token: 'abc', cnameTarget: 'shop.apps.localhost' });
    expect(r.ok).toBe(true);
  });
});
