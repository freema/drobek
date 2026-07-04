/**
 * SSRF-safe forward (PHY-59, R6 security core). The single choke point every
 * outbound proxy request goes through.
 *
 * Contract:
 *   1. Resolve the host to an IP ONCE (dns.lookup).
 *   2. Classify that IP — REJECT private/loopback/link-local/CGNAT/reserved/
 *      multicast (see ip-classify) UNLESS the host is on the operator's explicit
 *      `PROXY_ALLOWED_HOSTS` allow-list (empty by default → fully strict; a
 *      self-hoster may allow-list a specific internal backend, which is the whole
 *      point of a BFF gateway).
 *   3. CONNECT to that exact resolved IP (a pinned dns lookup) — NOT re-resolving
 *      — while the Host header + TLS SNI stay the original hostname, so a
 *      DNS-rebind cannot swap the IP between the check and the connect.
 *   4. NO redirect following — a 3xx is returned verbatim, never auto-followed to
 *      an internal target.
 *   5. A per-request connect/idle timeout + a response-size cap.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { ProxyError } from './errors.js';
import { isBlockedIp } from './ip-classify.js';

export const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Parse the operator's private-host allow-list (comma/space separated hostnames). */
export function proxyAllowedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.PROXY_ALLOWED_HOSTS ?? '';
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== '')
  );
}

function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface SsrfForwardInput {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  env?: NodeJS.ProcessEnv;
}

export interface SsrfForwardResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** The resolved IP we actually connected to (for audit, non-secret). */
  resolvedIp: string;
}

function resolveOnce(host: string): Promise<LookupAddress> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: false }, (err, address, family) => {
      if (err || !address) {
        reject(new ProxyError('upstream_error', 'upstream host could not be resolved'));
        return;
      }
      resolve({ address, family });
    });
  });
}

/**
 * Forward a single request to `url`, enforcing the SSRF contract above. Returns
 * the upstream response verbatim (status/headers/body). Never follows redirects.
 */
export async function ssrfSafeForward(
  input: SsrfForwardInput
): Promise<SsrfForwardResult> {
  const env = input.env ?? process.env;
  const host = input.url.hostname.replace(/^\[|\]$/g, '');
  const allowed = proxyAllowedHosts(env);

  const { address, family } = await resolveOnce(host);

  if (isBlockedIp(address) && !allowed.has(host.toLowerCase())) {
    // The resolved IP is internal/reserved and the host is not operator-allowed.
    throw new ProxyError(
      'ssrf_blocked',
      'upstream host resolves to a private/reserved address'
    );
  }

  const timeoutMs = intEnv(env.PROXY_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS);
  const maxBytes = intEnv(env.PROXY_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES);
  const lib = input.url.protocol === 'https:' ? https : http;

  // Pin the DNS result: the socket connects to `address` (no re-resolution), but
  // node still derives the Host header + TLS servername from `input.url` (the
  // hostname), so SNI/Host are correct and rebinding is impossible.
  const pinnedLookup: typeof dnsLookup = ((
    _hostname: string,
    options: unknown,
    cb: unknown
  ) => {
    const callback = (typeof options === 'function' ? options : cb) as (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number
    ) => void;
    const opts = (typeof options === 'object' && options ? options : {}) as {
      all?: boolean;
    };
    if (opts.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as unknown as typeof dnsLookup;

  return new Promise<SsrfForwardResult>((resolve, reject) => {
    const req = lib.request(
      input.url,
      {
        method: input.method,
        headers: input.headers,
        lookup: pinnedLookup,
        timeout: timeoutMs,
        // Redirects are NEVER auto-followed by node's http.request — we return
        // any 3xx verbatim. (No agent-level redirect handling exists here.)
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            reject(new ProxyError('upstream_error', 'upstream response exceeded the size cap'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) headers[k] = v.join(', ');
            else if (v !== undefined) headers[k] = v;
          }
          resolve({
            status: res.statusCode ?? 502,
            headers,
            body: Buffer.concat(chunks),
            resolvedIp: address,
          });
        });
        res.on('error', () =>
          reject(new ProxyError('upstream_error', 'upstream response error'))
        );
      }
    );

    req.on('timeout', () => {
      req.destroy(new ProxyError('upstream_error', 'upstream request timed out'));
    });
    req.on('error', (err) => {
      reject(
        err instanceof ProxyError
          ? err
          : new ProxyError('upstream_error', 'upstream request failed')
      );
    });

    if (input.body && input.body.length > 0) req.write(input.body);
    req.end();
  });
}
