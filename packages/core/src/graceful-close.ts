/**
 * Stopping an HTTP server without cutting the requests it is answering: the
 * server stops accepting connections, keep-alive sockets with no request on
 * them close at once (and every socket whose request finishes during the
 * drain), requests in flight get up to the grace period, and whatever still
 * runs after it is destroyed.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/** `SHUTDOWN_GRACE_MS` default: how long in-flight requests may run on after SIGTERM. */
export const SHUTDOWN_GRACE_DEFAULT_MS = 20_000;

/** How often sockets that became idle during the drain are closed. */
const IDLE_SWEEP_MS = 100;

/** `SHUTDOWN_GRACE_MS` (a positive integer, ms), else the default. */
export function shutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SHUTDOWN_GRACE_MS);
  return Number.isInteger(n) && n > 0 ? n : SHUTDOWN_GRACE_DEFAULT_MS;
}

export interface GracefulCloseResult {
  /** True when every request finished within the grace period; false when the rest were cut. */
  drained: boolean;
}

/**
 * Close `server` gracefully; resolves once every connection is gone or the
 * grace period ran out and the remaining connections were destroyed. A
 * request that arrives meanwhile on an open keep-alive socket is answered
 * with `Connection: close`. A socket taken over by an upgrade (a WebSocket)
 * is not tracked by the server and does not hold the promise past the grace.
 */
export function closeGracefully(server: Server, opts: { graceMs: number }): Promise<GracefulCloseResult> {
  return new Promise((resolve) => {
    let settled = false;
    const closeAfterResponse = (_req: IncomingMessage, res: ServerResponse): void => {
      if (!res.headersSent) res.setHeader('Connection', 'close');
    };
    const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      settle(false);
    }, opts.graceMs);
    function settle(drained: boolean): void {
      if (settled) return;
      settled = true;
      clearInterval(sweep);
      clearTimeout(deadline);
      server.off('request', closeAfterResponse);
      resolve({ drained });
    }
    server.prependListener('request', closeAfterResponse);
    server.close(() => settle(true));
    server.closeIdleConnections();
  });
}
