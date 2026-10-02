#!/usr/bin/env node
/**
 * Mock DNS server — tests-e2e ONLY, the `dns-mock` service of
 * docker-compose.e2e.yaml. The image flow runs NODE_ENV=production, where
 * drobek ignores DOMAINS_DNS_MOCK; it verifies custom domains over real DNS
 * against DOMAINS_DNS_SERVERS = this server's address instead. The answers
 * come from the same Redis keys the dev mock reads, so domains.spec.ts sets
 * records one way for both stacks:
 *
 *   drobek:dns-mock:<txt|cname|a|aaaa>:<name>   a JSON array of strings
 *                                               (a TXT record = one string)
 *
 * A missing key is NODATA (NOERROR, no answer), the value "SERVFAIL" answers
 * SERVFAIL, every answer has TTL 0 (nothing is cached between a spec's
 * steps). UDP only, dependency-free (node:dgram + a minimal RESP GET).
 *
 * Config: DNS_PORT (53), REDIS_URL (redis://redis:6379).
 * `node tests-e2e/dns-mock.mjs --probe` asks the running server once (the
 * compose healthcheck): exit 0 when it answers at all, 1 when it does not.
 */
import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { isIPv4, isIPv6, connect } from 'node:net';

const PORT = Number(process.env.DNS_PORT || 53);
const redisUrl = new URL(process.env.REDIS_URL || 'redis://redis:6379');
const TYPES = { 1: 'a', 5: 'cname', 16: 'txt', 28: 'aaaa' };
const RCODE = { noError: 0, formErr: 1, servFail: 2, notImp: 4 };

/** GET `key` from Redis: the string, or null when the key is missing. */
function redisGet(key) {
  return new Promise((resolve, reject) => {
    const k = Buffer.from(key, 'utf8');
    const sock = connect(Number(redisUrl.port || 6379), redisUrl.hostname);
    let buf = Buffer.alloc(0);
    sock.setTimeout(2_000, () => sock.destroy(new Error('redis timeout')));
    sock.on('connect', () => sock.write(Buffer.concat([Buffer.from(`*2\r\n$3\r\nGET\r\n$${k.length}\r\n`), k, Buffer.from('\r\n')])));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      const head = buf.subarray(0, nl).toString('utf8');
      if (head[0] !== '$') {
        sock.destroy();
        reject(new Error(`redis answered ${head}`));
        return;
      }
      const len = Number(head.slice(1));
      if (len < 0) {
        sock.end();
        resolve(null);
        return;
      }
      if (buf.length < nl + 2 + len + 2) return;
      sock.end();
      resolve(buf.subarray(nl + 2, nl + 2 + len).toString('utf8'));
    });
    sock.on('error', reject);
  });
}

/** The question of a query: name (lower case, no trailing dot), type and where it ends. */
function parseQuestion(msg) {
  const labels = [];
  let off = 12;
  for (;;) {
    if (off >= msg.length) return null;
    const len = msg[off];
    if (len === 0) break;
    if (len > 63 || off + 1 + len > msg.length) return null;
    labels.push(msg.subarray(off + 1, off + 1 + len).toString('latin1'));
    off += 1 + len;
  }
  if (off + 5 > msg.length) return null;
  return { name: labels.join('.').toLowerCase(), qtype: msg.readUInt16BE(off + 1), end: off + 5 };
}

function encodeName(name) {
  const parts = name.replace(/\.$/, '').split('.').filter(Boolean);
  return Buffer.concat([...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'latin1')])), Buffer.from([0])]);
}

function ipv6Bytes(ip) {
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

/** The RDATA of one value of `type`, or null when the value does not fit the type. */
function rdata(type, value) {
  if (type === 'a') return isIPv4(value) ? Buffer.from(value.split('.').map(Number)) : null;
  if (type === 'aaaa') return isIPv6(value) && !value.includes('.') ? ipv6Bytes(value) : null;
  if (type === 'cname') return encodeName(value);
  const bytes = Buffer.from(value, 'utf8');
  const chunks = [];
  for (let i = 0; i < bytes.length || i === 0; i += 255) {
    const part = bytes.subarray(i, i + 255);
    chunks.push(Buffer.from([part.length]), part);
  }
  return Buffer.concat(chunks);
}

function reply(query, end, rcode, answers = []) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  const opcode = (query[2] >> 3) & 0x0f;
  header.writeUInt16BE(0x8000 | (opcode << 11) | 0x0400 | (query.readUInt16BE(2) & 0x0100) | 0x0080 | rcode, 2);
  header.writeUInt16BE(end > 12 ? 1 : 0, 4);
  header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, query.subarray(12, end), ...answers]);
}

function answer(qtype, data) {
  const rr = Buffer.alloc(12);
  rr.writeUInt16BE(0xc00c, 0);
  rr.writeUInt16BE(qtype, 2);
  rr.writeUInt16BE(1, 4);
  rr.writeUInt32BE(0, 6);
  rr.writeUInt16BE(data.length, 10);
  return Buffer.concat([rr, data]);
}

async function handle(msg) {
  if (msg.length < 12) return null;
  const q = msg.readUInt16BE(4) === 1 ? parseQuestion(msg) : null;
  if (!q) return reply(msg, 12, RCODE.formErr);
  if (((msg[2] >> 3) & 0x0f) !== 0) return reply(msg, q.end, RCODE.notImp);
  const type = TYPES[q.qtype];
  if (!type) return reply(msg, q.end, RCODE.noError);
  let raw;
  try {
    raw = await redisGet(`drobek:dns-mock:${type}:${q.name}`);
  } catch (err) {
    console.error(`dns-mock: redis failed (${err.message}) — SERVFAIL ${type.toUpperCase()} ${q.name}`);
    return reply(msg, q.end, RCODE.servFail);
  }
  if (raw === null) return reply(msg, q.end, RCODE.noError);
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    values = null;
  }
  if (values === 'SERVFAIL' || !Array.isArray(values)) return reply(msg, q.end, RCODE.servFail);
  const answers = values.map((v) => rdata(type, String(v))).filter((d) => d !== null).map((d) => answer(q.qtype, d));
  console.log(`dns-mock: ${type.toUpperCase()} ${q.name} → ${answers.length} record(s)`);
  return reply(msg, q.end, RCODE.noError, answers);
}

async function probe() {
  const resolver = new Resolver({ timeout: 1_000, tries: 1 });
  resolver.setServers([`127.0.0.1:${PORT}`]);
  try {
    await resolver.resolveTxt('probe.dns-mock.invalid');
    return 0;
  } catch (err) {
    return err.code === 'ETIMEOUT' || err.code === 'ECONNREFUSED' ? 1 : 0;
  }
}

if (process.argv.includes('--probe')) {
  process.exit(await probe());
}

const server = createSocket('udp4');
server.on('message', (msg, peer) => {
  handle(msg).then(
    (out) => {
      if (out) server.send(out, peer.port, peer.address);
    },
    (err) => console.error(`dns-mock: ${err.message}`)
  );
});
server.bind(PORT, '0.0.0.0', () => console.log(`dns-mock listening on udp 0.0.0.0:${PORT} (records from ${redisUrl.host})`));
