/**
 * Streaming request bodies on node:http (NSO-325; shared since NSO-358 by the
 * app hosts' module uploads in @drobek/serving and the asset upload URL of
 * @drobek/apps). Typed on node:http only, so Express req/res fit too.
 *
 * `requestBodyStream` reads the body in paused mode — nothing is read ahead
 * of the consumer, so a slow disk write back-pressures the client.
 * `closeAfterResponse` is how an answer sent before the body fully arrived (a
 * 413 in the middle of an upload) reaches the client: see its comment.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/**
 * How long a connection closed under an unread body keeps discarding what the
 * client still sends after the answer went out (see closeAfterResponse).
 */
export const CLOSE_LINGER_MS = 2000;

/**
 * The request body as a pull stream (paused mode — nothing is read ahead of
 * the consumer, so a slow disk write back-pressures the client). `return()`
 * stops reading and lets the rest flow into the void: the upload is discarded,
 * never buffered, until the response is flushed and the connection closed
 * (closeAfterResponse). A client that goes away mid-body makes `next()` throw.
 */
export function requestBodyStream(req: IncomingMessage): AsyncIterableIterator<Buffer> {
  let ended = false;
  let failure: Error | null = null;
  let finished = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const onEnd = () => {
    ended = true;
    notify();
  };
  const onError = (err: Error) => {
    failure = err;
    notify();
  };
  const onClose = () => {
    if (!req.readableEnded) failure ??= new Error('the client aborted the request body');
    notify();
  };
  req.on('readable', notify);
  req.on('end', onEnd);
  req.on('error', onError);
  req.on('close', onClose);
  const cleanup = () => {
    finished = true;
    req.off('readable', notify);
    req.off('end', onEnd);
    req.off('error', onError);
    req.off('close', onClose);
  };
  const iter: AsyncIterableIterator<Buffer> = {
    [Symbol.asyncIterator]() {
      return iter;
    },
    async next() {
      for (;;) {
        if (finished) return { value: undefined, done: true };
        const chunk = req.read() as Buffer | null;
        if (chunk !== null) return { value: chunk, done: false };
        if (failure) {
          const err: Error = failure;
          cleanup();
          throw err;
        }
        if (ended || req.readableEnded) {
          cleanup();
          return { value: undefined, done: true };
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
    async return() {
      if (!finished) {
        cleanup();
        if (!req.readableEnded) req.resume();
      }
      return { value: undefined, done: true };
    },
  };
  return iter;
}

/**
 * The request body is still arriving while we answer: close the connection
 * instead of draining the rest. `Connection: close` tells the client. Once
 * the response is flushed (`finish` = the last byte handed to the OS — never
 * under a half-written response) the socket is half-closed (FIN after the
 * answer), what the client still sends is discarded, and CLOSE_LINGER_MS
 * later the socket is destroyed — once.
 *
 * Why the linger: destroying at once while the client is still sending makes
 * the kernel answer its next segment with a RST, and a client kernel that
 * gets the RST drops the response it has not read yet — the uploader sees
 * "connection reset" instead of the 413. Node's own close for a
 * `Connection: close` response (`socket.destroySoon()`: FIN, then destroy as
 * soon as it is written) has exactly that race, so it is replaced for this
 * socket.
 */
export function closeAfterResponse(req: IncomingMessage, res: ServerResponse): void {
  if (!res.headersSent) res.setHeader('Connection', 'close');
  const socket = req.socket as (Socket & { destroySoon?: () => void }) | null | undefined;
  if (!socket) return;
  socket.destroySoon = () => {}; // Node calls it on `finish` of a Connection: close response; we linger instead
  res.once('finish', () => {
    socket.end();
    req.resume();
    const timer = setTimeout(() => socket.destroy(), CLOSE_LINGER_MS);
    timer.unref?.();
    socket.once('close', () => clearTimeout(timer));
  });
}
