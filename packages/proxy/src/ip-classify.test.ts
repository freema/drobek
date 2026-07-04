import { describe, expect, it } from 'vitest';
import { classifyForwardIp, isBlockedIp, parseIpv4, parseIpv6 } from './ip-classify.js';

describe('parseIpv4', () => {
  it('parses a dotted quad', () => {
    expect(parseIpv4('1.2.3.4')).toEqual([1, 2, 3, 4]);
    expect(parseIpv4('255.255.255.255')).toEqual([255, 255, 255, 255]);
  });
  it('rejects malformed', () => {
    expect(parseIpv4('1.2.3')).toBeNull();
    expect(parseIpv4('1.2.3.256')).toBeNull();
    expect(parseIpv4('a.b.c.d')).toBeNull();
    expect(parseIpv4('1.2.3.4.5')).toBeNull();
  });
});

describe('parseIpv6', () => {
  it('parses loopback + expands ::', () => {
    expect(parseIpv6('::1')?.slice(-1)).toEqual([1]);
    expect(parseIpv6('::')).toEqual(new Array(16).fill(0));
  });
  it('parses an IPv4-mapped tail', () => {
    const b = parseIpv6('::ffff:10.0.0.1');
    expect(b?.slice(10)).toEqual([0xff, 0xff, 10, 0, 0, 1]);
  });
  it('rejects malformed', () => {
    expect(parseIpv6('gggg::')).toBeNull();
    expect(parseIpv6('1::2::3')).toBeNull();
  });
});

describe('SSRF classifier — PUBLIC addresses are allowed', () => {
  const publicIps = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '151.101.1.140',
    '199.232.0.0',
    '172.32.0.1', // just OUTSIDE 172.16/12
    '172.15.255.255', // just below 172.16/12
    '100.63.255.255', // just below 100.64/10 (CGNAT)
    '100.128.0.0', // just above 100.64/10
    '11.0.0.1', // just above 10/8
    '9.255.255.255', // just below 10/8
    '192.167.255.255', // just below 192.168/16
    '192.169.0.0', // just above 192.168/16
    '169.253.255.255', // just below link-local
    '169.255.0.0', // just above link-local
    '223.255.255.255', // just below multicast 224/4
    '2606:4700:4700::1111', // Cloudflare v6
    '2001:4860:4860::8888', // Google v6
  ];
  for (const ip of publicIps) {
    it(`allows ${ip}`, () => {
      expect(classifyForwardIp(ip).blocked, `${ip} => ${classifyForwardIp(ip).reason}`).toBe(false);
    });
  }
});

describe('SSRF classifier — every private/reserved range is BLOCKED', () => {
  const blocked: Array<[string, string]> = [
    ['0.0.0.0', 'this-network'],
    ['0.1.2.3', 'this-network'],
    ['10.0.0.1', 'private 10/8'],
    ['10.255.255.255', 'private 10/8'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.255', 'CGNAT'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.255', 'private 172.16/12'],
    ['192.0.0.1', 'ietf'],
    ['192.0.2.5', 'test-net-1'],
    ['192.168.0.1', 'private 192.168/16'],
    ['192.168.255.255', 'private 192.168/16'],
    ['198.18.0.1', 'benchmark'],
    ['198.19.255.255', 'benchmark'],
    ['198.51.100.7', 'test-net-2'],
    ['203.0.113.9', 'test-net-3'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast/reserved'],
  ];
  for (const [ip, label] of blocked) {
    it(`blocks ${ip} (${label})`, () => {
      expect(isBlockedIp(ip), `${ip} should be blocked`).toBe(true);
    });
  }
});

describe('SSRF classifier — IPv6 internal ranges + embedded IPv4', () => {
  const blocked = [
    '::', // unspecified
    '::1', // loopback
    'fc00::1', // ULA
    'fd12:3456::1', // ULA
    'fe80::1', // link-local
    'ff02::1', // multicast
    '2001:db8::1', // documentation
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:169.254.169.254', // IPv4-mapped metadata
    '::ffff:10.0.0.1', // IPv4-mapped private
    '64:ff9b::10.0.0.1', // NAT64 → embedded private
    '::127.0.0.1', // IPv4-compatible loopback
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => {
      expect(isBlockedIp(ip), `${ip} should be blocked`).toBe(true);
    });
  }
  it('allows an IPv4-mapped PUBLIC address', () => {
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('SSRF classifier — fails closed on garbage', () => {
  it('blocks unparseable input', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('')).toBe(true);
    expect(isBlockedIp('999.999.999.999')).toBe(true);
  });
});
