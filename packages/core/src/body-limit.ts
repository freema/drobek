/**
 * The request body cap in front of the dashboard's request handler (React
 * Router: the dashboard pages, the sign-in and the OAuth endpoints). A body
 * is never read past the cap:
 *
 *  - a declared `Content-Length` over it → 413 at once, nothing read. A body
 *    within its declared length passes untouched: the HTTP parser never
 *    delivers more than the declared length as this request's body;
 *  - a body without a declared length (`Transfer-Encoding: chunked`) is read
 *    and counted as it arrives: past the cap → 413 and the rest is discarded;
 *    within it, the bytes are put back into the request stream (`unshift`,
 *    before its `end` is emitted) and the handler is called in the same tick,
 *    so it attaches its own reader before the stream ends. A message that
 *    fully arrived before the cap looked at it is measured in the stream's
 *    buffer instead, without reading.
 *
 * A 413 closes the connection after the answer (closeAfterResponse). Paths
 * whose routes take larger bodies and enforce their own limits are passed
 * through untouched (`exempt`, matched on the normalized path — the same
 * `new URL()` normalization React Router routes on). Typed on node:http, so
 * Express handlers fit.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { closeAfterResponse } from './http-body.js';

/** DASHBOARD_MAX_BODY_BYTES when unset or invalid: 1 MiB. */
export const DASHBOARD_MAX_BODY_BYTES_DEFAULT = 1024 * 1024;

/** The dashboard's request body cap from DASHBOARD_MAX_BODY_BYTES (a positive integer, else the default). */
export function dashboardMaxBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DASHBOARD_MAX_BODY_BYTES);
  return Number.isInteger(n) && n > 0 ? n : DASHBOARD_MAX_BODY_BYTES_DEFAULT;
}

type Next = (err?: unknown) => void;

export interface BodyLimitOptions {
  /** The most bytes a request body may carry (DASHBOARD_MAX_BODY_BYTES). */
  maxBytes: number;
  /** A path whose route keeps its own, larger limit: never capped here. */
  exempt?: (pathname: string) => boolean;
}

type BodyRead = { kind: 'body'; bytes: Buffer } | { kind: 'too_large' } | { kind: 'aborted' };

/** The normalized path of the request (built like @react-router/express builds its URL), or null when it does not parse. */
function pathnameOf(req: IncomingMessage): string | null {
  try {
    return new URL(`http://localhost${req.url ?? '/'}`).pathname;
  } catch {
    return null;
  }
}

/**
 * Read a body without a declared length in paused mode, up to `max` bytes.
 * `done` runs once the parser delivered the whole message (the bytes are
 * still unconsumed as far as the stream's `end` is concerned), past `max`, or
 * when the client went away.
 */
function readUpTo(req: IncomingMessage, max: number, done: (r: BodyRead) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const finish = (r: BodyRead) => {
    if (settled) return;
    settled = true;
    req.off('readable', onReadable);
    req.off('end', onEnd);
    req.off('error', onAbort);
    req.off('close', onClose);
    done(r);
  };
  const onReadable = () => {
    let chunk: Buffer | null;
    while ((chunk = req.read() as Buffer | null) !== null) {
      size += chunk.length;
      if (size > max) {
        finish({ kind: 'too_large' });
        return;
      }
      chunks.push(chunk);
    }
    // `complete` is set before the parser ends the stream; the `end` the last
    // read() scheduled is still a tick away.
    if (req.complete) finish({ kind: 'body', bytes: Buffer.concat(chunks, size) });
  };
  // Only when the stream ended before a `readable` event (an empty body).
  const onEnd = () => finish({ kind: 'body', bytes: Buffer.concat(chunks, size) });
  const onAbort = () => finish({ kind: 'aborted' });
  const onClose = () => {
    if (!req.complete) finish({ kind: 'aborted' });
  };
  req.on('readable', onReadable);
  req.on('end', onEnd);
  req.on('error', onAbort);
  req.on('close', onClose);
}

function refuse(req: IncomingMessage, res: ServerResponse, maxBytes: number): void {
  req.resume();
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (!req.complete) closeAfterResponse(req, res);
  res.writeHead(413, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(
    JSON.stringify({
      error: 'payload_too_large',
      message: `The request body is over ${maxBytes} bytes, the most the dashboard, sign-in and OAuth endpoints accept. Nothing was read or changed.`,
      details: { limit: 'DASHBOARD_MAX_BODY_BYTES', value: maxBytes },
    })
  );
}

/** `handler` behind the body cap (see the module comment). */
export function withBodyLimit<Req extends IncomingMessage, Res extends ServerResponse>(
  handler: (req: Req, res: Res, next: Next) => unknown,
  opts: BodyLimitOptions
): (req: Req, res: Res, next: Next) => void {
  const call = (req: Req, res: Res, next: Next) => {
    try {
      void handler(req, res, next);
    } catch (err) {
      next(err);
    }
  };
  return (req, res, next) => {
    const declared = req.headers['content-length'];
    const chunked = declared === undefined && req.headers['transfer-encoding'] !== undefined;
    if (declared === undefined && !chunked) {
      call(req, res, next);
      return;
    }
    const path = pathnameOf(req);
    if (path !== null && opts.exempt?.(path)) {
      call(req, res, next);
      return;
    }
    if (!chunked) {
      if (Number(declared) > opts.maxBytes) refuse(req, res, opts.maxBytes);
      else call(req, res, next);
      return;
    }
    // The whole message already arrived (an async step ran in front): it is all
    // in the stream's buffer, nothing to read.
    if (req.complete) {
      if (req.readableLength > opts.maxBytes) refuse(req, res, opts.maxBytes);
      else call(req, res, next);
      return;
    }
    readUpTo(req, opts.maxBytes, (r) => {
      if (r.kind === 'aborted') return;
      if (r.kind === 'too_large') {
        refuse(req, res, opts.maxBytes);
        return;
      }
      if (r.bytes.length > 0 && !req.readableEnded) req.unshift(r.bytes);
      call(req, res, next);
    });
  };
}
