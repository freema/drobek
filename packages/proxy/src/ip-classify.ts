/**
 * SSRF IP-range classifier (PHY-59, R6 security core) — PURE + exhaustively
 * unit-tested. A secret-injecting BFF proxy MUST NOT be tricked into connecting
 * to an internal address. At forward time the host is resolved to an IP ONCE
 * (dns.lookup) and passed HERE; a blocked IP is rejected BEFORE any socket is
 * opened, and the connection is then pinned to this exact IP (no re-resolution),
 * so a DNS-rebind cannot swap the IP between the check and the connect.
 *
 * Fails CLOSED: anything unparseable is treated as blocked.
 *
 * Blocked IPv4 ranges: 0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8 (loopback),
 * 169.254/16 (link-local incl. 169.254.169.254 metadata), 172.16/12, 192.0.0/24,
 * 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4
 * (multicast), 240/4 (reserved incl. 255.255.255.255).
 * Blocked IPv6: :: (unspecified), ::1 (loopback), fc00::/7 (ULA), fe80::/10
 * (link-local), ff00::/8 (multicast), 2001:db8::/32 (doc). IPv4-mapped
 * (::ffff:0:0/96), IPv4-compatible (::/96) and NAT64 (64:ff9b::/96) unwrap to
 * the embedded IPv4 and are classified as that.
 */

export interface IpVerdict {
  blocked: boolean;
  reason: string;
}

const PUBLIC: IpVerdict = { blocked: false, reason: 'public' };

/** Parse a dotted-quad IPv4 → 4 bytes, or null. */
export function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

/** Parse an IPv6 literal (with `::` compression and optional embedded IPv4 tail
 * and optional `%zone`) → 16 bytes, or null. */
export function parseIpv6(ip: string): number[] | null {
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip === '') return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const groupsToBytes = (s: string): number[] | null => {
    if (s === '') return [];
    const groups = s.split(':');
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.includes('.')) {
        // Embedded IPv4 — only valid as the final group.
        if (i !== groups.length - 1) return null;
        const v4 = parseIpv4(g);
        if (!v4) return null;
        out.push(...v4);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        const n = parseInt(g, 16);
        out.push((n >> 8) & 0xff, n & 0xff);
      }
    }
    return out;
  };

  if (halves.length === 2) {
    const head = groupsToBytes(halves[0]);
    const tail = groupsToBytes(halves[1]);
    if (head === null || tail === null) return null;
    const missing = 16 - head.length - tail.length;
    if (missing < 0) return null;
    return [...head, ...new Array(missing).fill(0), ...tail];
  }
  const all = groupsToBytes(ip);
  if (all === null || all.length !== 16) return null;
  return all;
}

function u32(b: number[]): number {
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

function inCidr4(ipInt: number, base: string, prefix: number): boolean {
  const baseInt = u32(parseIpv4(base) as number[]);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const BLOCKED_V4: Array<{ base: string; prefix: number; reason: string }> = [
  { base: '0.0.0.0', prefix: 8, reason: 'this-network' },
  { base: '10.0.0.0', prefix: 8, reason: 'private-10/8' },
  { base: '100.64.0.0', prefix: 10, reason: 'cgnat-100.64/10' },
  { base: '127.0.0.0', prefix: 8, reason: 'loopback-127/8' },
  { base: '169.254.0.0', prefix: 16, reason: 'link-local-169.254/16' },
  { base: '172.16.0.0', prefix: 12, reason: 'private-172.16/12' },
  { base: '192.0.0.0', prefix: 24, reason: 'ietf-192.0.0/24' },
  { base: '192.0.2.0', prefix: 24, reason: 'test-net-1' },
  { base: '192.168.0.0', prefix: 16, reason: 'private-192.168/16' },
  { base: '198.18.0.0', prefix: 15, reason: 'benchmark-198.18/15' },
  { base: '198.51.100.0', prefix: 24, reason: 'test-net-2' },
  { base: '203.0.113.0', prefix: 24, reason: 'test-net-3' },
  { base: '224.0.0.0', prefix: 4, reason: 'multicast-224/4' },
  { base: '240.0.0.0', prefix: 4, reason: 'reserved-240/4' },
];

function classifyV4(bytes: number[]): IpVerdict {
  const ipInt = u32(bytes);
  for (const r of BLOCKED_V4) {
    if (inCidr4(ipInt, r.base, r.prefix)) return { blocked: true, reason: r.reason };
  }
  return PUBLIC;
}

function allZero(bytes: number[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
}

function classifyV6(b: number[]): IpVerdict {
  // ::/128 unspecified
  if (allZero(b, 0, 16)) return { blocked: true, reason: 'unspecified-::' };
  // ::1 loopback
  if (allZero(b, 0, 15) && b[15] === 1) return { blocked: true, reason: 'loopback-::1' };

  // IPv4-mapped ::ffff:0:0/96 → classify embedded IPv4.
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return classifyV4(b.slice(12, 16));
  }
  // NAT64 64:ff9b::/96 → classify embedded IPv4.
  if (
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    allZero(b, 4, 12)
  ) {
    return classifyV4(b.slice(12, 16));
  }
  // IPv4-compatible (deprecated) ::a.b.c.d — first 12 bytes zero, non-zero tail.
  if (allZero(b, 0, 12)) return classifyV4(b.slice(12, 16));

  // ULA fc00::/7
  if ((b[0] & 0xfe) === 0xfc) return { blocked: true, reason: 'ula-fc00/7' };
  // link-local fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) {
    return { blocked: true, reason: 'link-local-fe80/10' };
  }
  // multicast ff00::/8
  if (b[0] === 0xff) return { blocked: true, reason: 'multicast-ff00/8' };
  // documentation 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) {
    return { blocked: true, reason: 'doc-2001:db8/32' };
  }
  return PUBLIC;
}

/**
 * Classify a numeric IP literal. Anything not parseable as IPv4 or IPv6 is
 * BLOCKED (fail closed) — dns.lookup only ever hands us a canonical numeric IP.
 */
export function classifyForwardIp(ip: string): IpVerdict {
  const v4 = parseIpv4(ip);
  if (v4) return classifyV4(v4);
  const v6 = parseIpv6(ip);
  if (v6) return classifyV6(v6);
  return { blocked: true, reason: 'unparseable' };
}

/** True when this IP must NOT be connected to (private/reserved/etc.). */
export function isBlockedIp(ip: string): boolean {
  return classifyForwardIp(ip).blocked;
}
