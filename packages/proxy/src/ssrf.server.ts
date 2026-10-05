/**
 * SSRF-safe forward. The single choke point every
 * outbound proxy request goes through.
 *
 * Contract:
 *   1. Resolve the host to an IP ONCE (dns.lookup).
 *   1b. The destination PORT must be on the allow-list (80/443 by default,
 *      `PROXY_ALLOWED_PORTS`) — re-asserted here, at connect time,
 *      not only at registration.
 *   2. Classify that IP — REJECT private/loopback/link-local/CGNAT/reserved/
 *      multicast (see ip-classify) UNLESS the host is on the operator's explicit
 *      `PROXY_ALLOWED_HOSTS` allow-list (empty by default → fully strict; a
 *      self-hoster may allow-list a specific internal backend, which is the whole
 *      point of a BFF gateway).
 *   3. CONNECT to that exact resolved IP (a pinned dns lookup) — NOT re-resolving
 *      — while the Host header + TLS SNI stay the original hostname, so a
 *      DNS-rebind cannot swap the IP between the check and the connect.
 *   4. One request, one hop: a 3xx is returned to the caller, never followed
 *      here (forwardToUpstream follows a redirect only within the upstream's
 *      origin and prefixes, each hop through this guard again).
 *   5. A connect timeout that ends once the TCP / TLS connection stands (a
 *      slow answer is bounded by the caller's deadline, not by it), an
 *      optional wall-clock deadline and a response-size cap (a HEAD / 204 /
 *      304 answer's declared length is not a body and is not held to it).
 *   6. A buffered request body goes out with `Content-Length`, never chunked.
 *
 * `openUpstreamRequest` sends the request and resolves at the response
 * headers; `ssrfSafeForward` reads the body buffered within the cap, and
 * `streamUpstreamBody` relays it as a Readable with a byte cap, an idle timer
 * and a hard maximum duration.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { Transform, type Readable } from 'node:stream';
import { ProxyError } from './errors.js';
import { isBlockedIp } from './ip-classify.js';
import { effectivePort, proxyAllowedPorts } from './validate.js';

export const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MiB
/** Wall-clock cap of a buffered proxied exchange, and of the wait for a stream's headers. */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
/** A streamed answer is cut after this long without a byte from the upstream. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
/** A streamed answer is cut after this long in total. */
export const DEFAULT_STREAM_MAX_MS = 600_000;
/** A streamed answer is cut past this many bytes. */
export const DEFAULT_STREAM_MAX_BYTES = 32 * 1024 * 1024;

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

/** A positive integer env value, or the fallback (unset / blank / invalid). */
export function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The response size cap (PROXY_MAX_RESPONSE_BYTES, default 5 MiB) — also the cap of a DECODED body. */
export function proxyMaxResponseBytes(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.PROXY_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES);
}

/** PROXY_RESPONSE_TIMEOUT_MS: a buffered exchange (redirects included), or the wait for a stream's headers. */
export function proxyResponseTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.PROXY_RESPONSE_TIMEOUT_MS, DEFAULT_RESPONSE_TIMEOUT_MS);
}

export interface StreamLimits {
  /** PROXY_STREAM_IDLE_TIMEOUT_MS */
  idleMs: number;
  /** PROXY_STREAM_MAX_MS */
  maxMs: number;
  /** PROXY_STREAM_MAX_BYTES */
  maxBytes: number;
}

/** The caps of a streamed answer from the env. */
export function proxyStreamLimits(env: NodeJS.ProcessEnv = process.env): StreamLimits {
  return {
    idleMs: intEnv(env.PROXY_STREAM_IDLE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    maxMs: intEnv(env.PROXY_STREAM_MAX_MS, DEFAULT_STREAM_MAX_MS),
    maxBytes: intEnv(env.PROXY_STREAM_MAX_BYTES, DEFAULT_STREAM_MAX_BYTES),
  };
}

export interface UpstreamRequestInput {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  env?: NodeJS.ProcessEnv;
  /**
   * Replaces the `PROXY_ALLOWED_HOSTS` operator allow-list for this call. A
   * caller that is NOT the BFF proxy (e.g. the OAuth CIMD fetch) passes its own
   * set — usually empty — so the proxy's allow-list never widens it.
   */
  allowedHosts?: ReadonlySet<string>;
  /**
   * Replaces the `PROXY_ALLOWED_PORTS` allow-list (default 80/443) for this
   * call — e.g. the CIMD fetch passes the one port its URL check vouched for.
   */
  allowedPorts?: ReadonlySet<number>;
  /** Overrides PROXY_CONNECT_TIMEOUT_MS: how long the TCP / TLS connect may take. */
  timeoutMs?: number;
}

export interface OpenUpstreamInput extends UpstreamRequestInput {
  /** Aborting it destroys the request; before the headers the promise rejects with its reason (a ProxyError). */
  signal?: AbortSignal;
}

export interface OpenedUpstream {
  status: number;
  headers: Record<string, string>;
  /** The unread response body; destroying it closes the upstream connection. */
  response: IncomingMessage;
  /** The resolved IP we actually connected to (for audit, non-secret). */
  resolvedIp: string;
}

export interface SsrfForwardInput extends UpstreamRequestInput {
  /** Overrides PROXY_MAX_RESPONSE_BYTES (enforced while reading). */
  maxResponseBytes?: number;
  /** Optional wall-clock cap for the whole exchange (a slow drip cannot outlive it). */
  deadlineMs?: number;
}

export interface SsrfForwardResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** The resolved IP we actually connected to (for audit, non-secret). */
  resolvedIp: string;
}

export const upstreamTimedOut = (): ProxyError => new ProxyError('upstream_error', 'upstream request timed out');
const tooLarge = () => new ProxyError('upstream_error', 'upstream response exceeded the size cap');
const responseError = () => new ProxyError('upstream_error', 'upstream response error');

function abortReason(signal: AbortSignal): ProxyError {
  return signal.reason instanceof ProxyError ? signal.reason : upstreamTimedOut();
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

function flatHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) out[k] = v.join(', ');
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Send one request to `url` under the SSRF contract above and resolve at the
 * response headers. The connect timeout ends once the connection stands; the
 * caller bounds the rest through `signal`.
 */
export async function openUpstreamRequest(input: OpenUpstreamInput): Promise<OpenedUpstream> {
  const env = input.env ?? process.env;
  const host = input.url.hostname.replace(/^\[|\]$/g, '');
  const allowed = input.allowedHosts ?? proxyAllowedHosts(env);
  const ports = input.allowedPorts ?? proxyAllowedPorts(env);

  if (!ports.has(effectivePort(input.url))) {
    // Checked before any DNS lookup: a non-web port is never contacted.
    throw new ProxyError('ssrf_blocked', 'upstream port is not allowed');
  }

  const { address, family } = await resolveOnce(host);

  if (isBlockedIp(address) && !allowed.has(host.toLowerCase())) {
    // The resolved IP is internal/reserved and the host is not operator-allowed.
    throw new ProxyError(
      'ssrf_blocked',
      'upstream host resolves to a private/reserved address'
    );
  }

  const signal = input.signal;
  if (signal?.aborted) throw abortReason(signal);

  const connectMs =
    input.timeoutMs ?? intEnv(env.PROXY_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS);
  const secure = input.url.protocol === 'https:';
  const lib = secure ? https : http;
  const hasBody = input.body !== undefined && input.body.length > 0;
  // The body is fully buffered (≤ the route's cap): send it with its length,
  // never chunked — some upstreams refuse `Transfer-Encoding: chunked`.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    const name = k.toLowerCase();
    if (name !== 'content-length' && name !== 'transfer-encoding') headers[k] = v;
  }
  if (hasBody) headers['content-length'] = String(input.body!.length);

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

  return new Promise<OpenedUpstream>((resolve, reject) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    const onAbort = () => req?.destroy(abortReason(signal!));
    const settle = () => {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
    };
    req = lib.request(
      input.url,
      { method: input.method, headers, lookup: pinnedLookup },
      (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        settle();
        resolve({ status: res.statusCode ?? 502, headers: flatHeaders(res.headers), response: res, resolvedIp: address });
      }
    );
    signal?.addEventListener('abort', onAbort, { once: true });

    req.on('socket', (socket) => {
      // A reused keep-alive socket is connected already.
      if (!socket.connecting) return;
      const timer = setTimeout(() => req?.destroy(upstreamTimedOut()), connectMs);
      timer.unref();
      const connected = () => clearTimeout(timer);
      socket.once(secure ? 'secureConnect' : 'connect', connected);
      socket.once('close', connected);
    });
    req.on('error', (err) => {
      if (settled) return;
      settle();
      reject(
        err instanceof ProxyError
          ? err
          : new ProxyError('upstream_error', 'upstream request failed')
      );
    });

    if (hasBody) req.end(input.body);
    else req.end();
  });
}

/** Read an opened response whole, within `maxBytes`; aborting `signal` destroys it. */
export function readUpstreamBody(
  opened: OpenedUpstream,
  method: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<SsrfForwardResult> {
  const res = opened.response;
  return new Promise<SsrfForwardResult>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let total = 0;
    const onAbort = () => fail(abortReason(signal!));
    const fail = (err: ProxyError) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      res.destroy();
      reject(err);
    };
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve({ status: opened.status, headers: opened.headers, body: Buffer.concat(chunks), resolvedIp: opened.resolvedIp });
    });
    res.on('error', () => fail(responseError()));
    res.on('close', () => {
      if (!res.complete) fail(responseError());
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    // A HEAD answer (and a 204/304) carries no body: its Content-Length
    // describes the resource, so a large resource is no reason to refuse.
    const noBody = method.toUpperCase() === 'HEAD' || opened.status === 204 || opened.status === 304;
    const declared = Number(opened.headers['content-length']);
    if (!noBody && Number.isFinite(declared) && declared > maxBytes) fail(tooLarge());
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
  const maxBytes = input.maxResponseBytes ?? proxyMaxResponseBytes(env);
  const ctrl = new AbortController();
  let deadline: NodeJS.Timeout | undefined;
  if (input.deadlineMs !== undefined) {
    deadline = setTimeout(() => ctrl.abort(upstreamTimedOut()), input.deadlineMs);
    deadline.unref();
  }
  try {
    const opened = await openUpstreamRequest({ ...input, signal: ctrl.signal });
    return await readUpstreamBody(opened, input.method, maxBytes, ctrl.signal);
  } finally {
    clearTimeout(deadline);
  }
}

/** Why a streamed answer ended: completely, cut by one of its caps, an upstream failure or the client leaving. */
export type StreamEndReason = 'end' | StreamCutReason | 'upstream_error' | 'client_closed';

/** The reasons a cap cuts a stream. */
export type StreamCutReason = 'stream_idle' | 'stream_too_large' | 'stream_too_long';

export interface StreamEnd {
  /** Bytes relayed (a dropped over-cap chunk and the trailer not counted). */
  bytes: number;
  /** Since the stream opened. */
  ms: number;
  reason: StreamEndReason;
}

export interface StreamBodyOptions extends StreamLimits {
  /**
   * The last chunk written when a cap cuts the stream (e.g. an SSE error
   * event). `tail` = the last bytes relayed, to start it on a clean boundary.
   */
  trailer?: (reason: StreamCutReason, tail: Buffer) => Buffer | null;
  /** Called once, when the stream is over for whatever reason; `err` only for an upstream failure. */
  finished: (err: ProxyError | null, end: StreamEnd) => void;
}

/**
 * Relay an opened response as a Readable: each chunk passes as it arrives
 * (with backpressure), counted against `maxBytes`; `idleMs` without a chunk
 * or `maxMs` in total cut it (the upstream connection is closed, `trailer`
 * appended, the Readable ends). Destroying the Readable closes the upstream
 * connection.
 */
export function streamUpstreamBody(opened: OpenedUpstream, opts: StreamBodyOptions): Readable {
  const res = opened.response;
  const started = Date.now();
  let bytes = 0;
  let tail = Buffer.alloc(0);
  let cut: StreamCutReason | null = null;
  let over = false;
  let idle: NodeJS.Timeout | undefined;
  let hard: NodeJS.Timeout | undefined;

  const finish = (err: ProxyError | null, reason: StreamEndReason) => {
    if (over) return;
    over = true;
    clearTimeout(idle);
    clearTimeout(hard);
    opts.finished(err, { bytes, ms: Date.now() - started, reason });
  };

  const out = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (cut !== null) {
        cb();
        return;
      }
      if (bytes + chunk.length > opts.maxBytes) {
        cb();
        stop('stream_too_large');
        return;
      }
      bytes += chunk.length;
      tail = Buffer.concat([tail, chunk]).subarray(-2);
      armIdle();
      cb(null, chunk);
    },
    flush(cb) {
      if (cut !== null) {
        const last = opts.trailer?.(cut, tail);
        if (last) this.push(last);
      }
      finish(null, cut ?? 'end');
      cb();
    },
  });

  function stop(reason: StreamCutReason): void {
    if (cut !== null || over) return;
    cut = reason;
    clearTimeout(idle);
    clearTimeout(hard);
    res.unpipe(out);
    res.destroy();
    out.end();
  }
  function armIdle(): void {
    clearTimeout(idle);
    idle = setTimeout(() => stop('stream_idle'), opts.idleMs);
    idle.unref();
  }

  const upstreamFailed = () => {
    if (cut !== null || over) return;
    const err = responseError();
    finish(err, 'upstream_error');
    res.unpipe(out);
    out.destroy(err);
  };
  res.on('error', upstreamFailed);
  res.on('close', () => {
    if (!res.complete) upstreamFailed();
  });
  out.on('close', () => {
    if (over) return;
    res.destroy();
    finish(null, 'client_closed');
  });

  hard = setTimeout(() => stop('stream_too_long'), opts.maxMs);
  hard.unref();
  armIdle();
  res.pipe(out);
  return out;
}
