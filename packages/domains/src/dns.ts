/**
 * The DNS side of custom-domain verification (M3-01).
 *
 * Both records are required:
 *   TXT   `_drobek.<hostname>`  one record equal to `drobek-verify=<token>`
 *         (proves the owner controls the name — the token is per domain row);
 *   CNAME `<hostname>`          → `<slug>.<APPS_DOMAIN>` (the traffic reaches
 *         THIS app). An apex cannot hold a CNAME, so a name whose IPv4/IPv6
 *         addresses are all addresses of `<slug>.<APPS_DOMAIN>` (ALIAS / ANAME
 *         / CNAME flattening, or plain A records to the same IP) passes too.
 *
 * Every lookup has a hard timeout (5 s). A failure is DEFINITIVE when the
 * resolver says the record does not exist or holds something else
 * (NXDOMAIN / NODATA / wrong value) and TRANSIENT otherwise (timeout,
 * SERVFAIL, network): the daily re-check drops a verification only on a
 * definitive failure, never because a resolver hiccupped.
 *
 * The resolver is injected (`DnsResolver`): production uses `node:dns`
 * (`nodeDnsResolver`), dev / e2e may use the Redis-backed mock
 * (`redisDnsMock`, DOMAINS_DNS_MOCK=redis — ignored in production).
 */
import { Resolver } from 'node:dns/promises';
import { verificationRecordName, verificationRecordValue } from './hostname.js';

/** The subset of `node:dns/promises` the verification needs. */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

export const DNS_TIMEOUT_MS = 5_000;

/** Resolver codes that mean "the record is not there" (not "we could not ask"). */
const ABSENT_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NOTFOUND']);

type Lookup<T> = { ok: true; value: T } | { ok: false; absent: boolean; code: string };

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'EUNKNOWN';
}

async function lookup<T>(fn: () => Promise<T>, timeoutMs: number): Promise<Lookup<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), timeoutMs);
  });
  try {
    return { ok: true, value: await Promise.race([fn(), timeout]) };
  } catch (err) {
    const code = errorCode(err);
    return { ok: false, absent: ABSENT_CODES.has(code), code };
  } finally {
    clearTimeout(timer);
  }
}

const norm = (name: string) => name.trim().toLowerCase().replace(/\.+$/, '');

export type RecordStatus = 'ok' | 'missing' | 'wrong' | 'unavailable';

export interface DomainDnsResult {
  /** Both records are in place. */
  ok: boolean;
  /** Not ok, but only because a lookup could not be completed (keep an existing verification). */
  transient: boolean;
  txt: RecordStatus;
  target: RecordStatus;
  /** A short, owner-facing explanation (null when ok). */
  error: string | null;
}

export interface DomainDnsInput {
  hostname: string;
  token: string;
  /** `<slug>.<APPS_DOMAIN>` without a port. */
  cnameTarget: string;
}

async function checkTxt(r: DnsResolver, input: DomainDnsInput, timeoutMs: number): Promise<RecordStatus> {
  const res = await lookup(() => r.resolveTxt(verificationRecordName(input.hostname)), timeoutMs);
  if (!res.ok) return res.absent ? 'missing' : 'unavailable';
  const want = verificationRecordValue(input.token);
  // A TXT record may be split into several character strings; they concatenate.
  const values = res.value.map((chunks) => chunks.join('').trim());
  if (values.length === 0) return 'missing';
  return values.includes(want) ? 'ok' : 'wrong';
}

async function addresses(r: DnsResolver, name: string, timeoutMs: number): Promise<Set<string> | null> {
  const [v4, v6] = await Promise.all([lookup(() => r.resolve4(name), timeoutMs), lookup(() => r.resolve6(name), timeoutMs)]);
  if ((!v4.ok && !v4.absent) || (!v6.ok && !v6.absent)) return null; // could not ask
  const out = new Set<string>();
  for (const res of [v4, v6]) if (res.ok) for (const a of res.value) out.add(a.toLowerCase());
  return out;
}

async function checkTarget(r: DnsResolver, input: DomainDnsInput, timeoutMs: number): Promise<RecordStatus> {
  const want = norm(input.cnameTarget);
  const cname = await lookup(() => r.resolveCname(input.hostname), timeoutMs);
  if (cname.ok && cname.value.some((v) => norm(v) === want)) return 'ok';

  // No (matching) CNAME: the same addresses as the app host also prove the
  // traffic reaches drobek for this app (apex ALIAS / flattening, A records).
  const [mine, theirs] = await Promise.all([
    addresses(r, input.hostname, timeoutMs),
    addresses(r, want, timeoutMs),
  ]);
  if (mine && theirs && mine.size > 0 && theirs.size > 0 && [...mine].every((a) => theirs.has(a))) return 'ok';

  if (cname.ok && cname.value.length > 0) return 'wrong';
  if (!cname.ok && !cname.absent) return 'unavailable';
  if (mine === null || theirs === null) return 'unavailable';
  return mine.size > 0 ? 'wrong' : 'missing';
}

const TXT_MSG: Record<Exclude<RecordStatus, 'ok'>, string> = {
  missing: 'the TXT record _drobek.<host> was not found',
  wrong: 'the TXT record _drobek.<host> does not contain the verification value',
  unavailable: 'the TXT record could not be looked up (DNS timeout or server failure)',
};
const TARGET_MSG: Record<Exclude<RecordStatus, 'ok'>, string> = {
  missing: 'the CNAME record was not found',
  wrong: 'the CNAME record points somewhere else',
  unavailable: 'the CNAME record could not be looked up (DNS timeout or server failure)',
};

/** Look both records up (in parallel, each with the timeout) and judge them. */
export async function checkDomainDns(
  resolver: DnsResolver,
  input: DomainDnsInput,
  opts: { timeoutMs?: number } = {}
): Promise<DomainDnsResult> {
  const timeoutMs = opts.timeoutMs ?? DNS_TIMEOUT_MS;
  const [txt, target] = await Promise.all([checkTxt(resolver, input, timeoutMs), checkTarget(resolver, input, timeoutMs)]);
  const ok = txt === 'ok' && target === 'ok';
  const problems: string[] = [];
  if (txt !== 'ok') problems.push(TXT_MSG[txt].replace('<host>', input.hostname));
  if (target !== 'ok') problems.push(TARGET_MSG[target]);
  const definitive = [txt, target].some((s) => s === 'missing' || s === 'wrong');
  return {
    ok,
    transient: !ok && !definitive,
    txt,
    target,
    error: ok ? null : `${problems.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()),
  };
}

/** `node:dns` with the timeout and (optionally) fixed nameservers (DOMAINS_DNS_SERVERS). */
export function nodeDnsResolver(opts: { servers?: string[]; timeoutMs?: number } = {}): DnsResolver {
  const resolver = new Resolver({ timeout: opts.timeoutMs ?? DNS_TIMEOUT_MS, tries: 1 });
  if (opts.servers && opts.servers.length > 0) resolver.setServers(opts.servers);
  return {
    resolveTxt: (n) => resolver.resolveTxt(n),
    resolveCname: (n) => resolver.resolveCname(n),
    resolve4: (n) => resolver.resolve4(n),
    resolve6: (n) => resolver.resolve6(n),
  };
}

/** Redis key of one mocked record set: `drobek:dns-mock:<type>:<name>` (JSON array of strings). */
export function dnsMockKey(type: 'txt' | 'cname' | 'a' | 'aaaa', name: string): string {
  return `drobek:dns-mock:${type}:${norm(name)}`;
}

/** The Redis commands the mock needs. */
export interface DnsMockRedis {
  get(key: string): Promise<string | null>;
}

/**
 * DEV / E2E ONLY (DOMAINS_DNS_MOCK=redis, ignored when NODE_ENV=production):
 * answers from Redis keys the e2e writes, `dnsMockKey(type, name)` → a JSON
 * array of strings (a TXT record = one string). A missing key is NODATA; the
 * value `"SERVFAIL"` simulates a failing resolver.
 */
export function redisDnsMock(redis: () => DnsMockRedis): DnsResolver {
  const read = async (type: 'txt' | 'cname' | 'a' | 'aaaa', name: string): Promise<string[]> => {
    const raw = await redis().get(dnsMockKey(type, name));
    if (raw === null) throw Object.assign(new Error(`mock: no ${type} for ${name}`), { code: 'ENODATA' });
    const value = JSON.parse(raw) as unknown;
    if (value === 'SERVFAIL') throw Object.assign(new Error('mock: SERVFAIL'), { code: 'ESERVFAIL' });
    if (!Array.isArray(value)) throw Object.assign(new Error('mock: bad value'), { code: 'EBADRESP' });
    return value.map(String);
  };
  return {
    resolveTxt: async (n) => (await read('txt', n)).map((v) => [v]),
    resolveCname: (n) => read('cname', n),
    resolve4: (n) => read('a', n),
    resolve6: (n) => read('aaaa', n),
  };
}
