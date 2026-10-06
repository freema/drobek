/**
 * A server-sent event stream of a module route, read with `fetch` (not
 * `EventSource`): the SDK sees the HTTP status and the `{ error }` body of a
 * refused stream, sends `X-Drobek-SDK: 1`, and resumes with `Last-Event-ID`
 * after every reconnect.
 *
 * A dropped connection, a stream the server ended (its lifetime, a restart)
 * and a 429 / 5xx answer reconnect after a delay that grows to 30 s; a 4xx
 * answer or an `event: error` with such a code stops for good (`onError`).
 * `close()` stops it at once; no callback runs after it.
 */
import { DrobekError, SDK_HEADER } from './core.js';

/** One event: `type` is the SSE `event:` field (default `message`). */
export interface StreamEvent {
  type: string;
  data: string;
  id: string | null;
}

export interface EventStreamOptions {
  onEvent(event: StreamEvent): void;
  /** The stream stopped for good (a 4xx answer, or an `error` event with a code that will not change by retrying). */
  onError?(error: DrobekError): void;
  /** First reconnect delay in ms (default 1000; the server's `retry:` field overrides it). */
  retryMs?: number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

const MAX_RETRY_MS = 30_000;

/** Codes that a retry does not change: the stream stops. */
const FATAL = new Set(['unauthorized', 'forbidden', 'not_found', 'invalid_request', 'module_not_enabled', 'pending_confirmation', 'password_required']);

/** Incremental SSE parser: feed text chunks, get the complete events. */
export function sseParser(): { push(chunk: string): StreamEvent[]; retry(): number | null } {
  let buffer = '';
  let type = '';
  let data: string[] = [];
  let id: string | null = null;
  let lastId: string | null = null;
  let retry: number | null = null;
  return {
    push(chunk) {
      buffer += chunk;
      const out: StreamEvent[] = [];
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? nl + 2 : nl + 1);
        if (line === '') {
          if (id !== null) lastId = id;
          if (data.length > 0) out.push({ type: type || 'message', data: data.join('\n'), id: lastId });
          type = '';
          data = [];
          id = null;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') type = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id' && !value.includes('\0')) id = value;
        else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
      }
      return out;
    },
    retry: () => retry,
  };
}

async function refusal(res: Response): Promise<DrobekError> {
  let b: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === 'object') b = parsed as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return new DrobekError(
    res.status,
    typeof b.error === 'string' ? b.error : 'http_error',
    typeof b.message === 'string' ? b.message : `${res.status} ${res.statusText}`.trim(),
    b.details,
    typeof b.hint === 'string' ? b.hint : undefined
  );
}

/** Open `url` (same origin) as an event stream; returns `close()`. */
export function openEventStream(url: string, opts: EventStreamOptions): () => void {
  const doFetch = opts.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const base = opts.retryMs ?? 1000;
  let closed = false;
  let lastId: string | null = null;
  let delay = base;
  let serverRetry: number | null = null;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (err: DrobekError) => {
    if (closed) return;
    closed = true;
    controller?.abort();
    opts.onError?.(err);
  };

  const schedule = () => {
    if (closed) return;
    const wait = Math.min(serverRetry ?? delay, MAX_RETRY_MS);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, wait);
  };

  async function connect(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    const headers: Record<string, string> = { Accept: 'text/event-stream', [SDK_HEADER]: '1' };
    if (lastId !== null) headers['Last-Event-ID'] = lastId;
    let res: Response;
    try {
      res = await doFetch(url, { method: 'GET', headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    } catch {
      schedule();
      return;
    }
    if (closed) return;
    if (!res.ok || !res.body) {
      const err = await refusal(res);
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) stop(err);
      else schedule();
      return;
    }
    const parser = sseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || closed) break;
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          if (closed) break;
          if (ev.id !== null) lastId = ev.id;
          delay = base;
          if (ev.type === 'error') {
            let b: Record<string, unknown> = {};
            try {
              b = JSON.parse(ev.data) as Record<string, unknown>;
            } catch {
              /* not JSON */
            }
            const code = typeof b.error === 'string' ? b.error : 'stream_error';
            const err = new DrobekError(0, code, typeof b.message === 'string' ? b.message : 'The event stream ended with an error.', b.details);
            if (FATAL.has(code)) {
              stop(err);
              return;
            }
            continue;
          }
          opts.onEvent(ev);
        }
        serverRetry = parser.retry();
      }
    } catch {
      /* the connection dropped: reconnect */
    } finally {
      reader.cancel().catch(() => undefined);
    }
    schedule();
  }

  void connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
  };
}
