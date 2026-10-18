/**
 * The screenshot answer endpoint: `/api/screenshots/<request_id>` on the
 * DASHBOARD host, mounted by apps/server before the Origin (CSRF) check and
 * React Router. Typed on node:http only, so Express req/res fit.
 *
 *   POST     multipart/form-data from the preview script (`fetch`, no
 *            credentials): `token` (from the request event), `action`
 *            (`capture`, the default, or `decline`), `screenshot` (the image,
 *            at most SCREENSHOT_MAX_BYTES), `path` and `browser`. The token
 *            in the body is the only credential — no cookie is read; it works
 *            once. The body is read up to SCREENSHOT_MAX_BYTES + 64 KiB (413
 *            past it). 200 `{ status: "ready", width, height }` or
 *            `{ status: "declined" }`; a refusal is `{ code, message, hint }`
 *            (404 not_found — unknown, answered or expired; 403 forbidden —
 *            a wrong token or a page of another origin; 413
 *            payload_too_large; 415 unsupported_media_type — not a PNG, JPEG
 *            or WebP that decodes; 400 invalid_request).
 *   OPTIONS  the CORS preflight.
 *
 * CORS: a browser request must come from one of the app's own hosts (its
 * `<slug>`, `<slug>--preview` and `<slug>--v<N>` hosts under APPS_DOMAIN, or
 * one of its verified custom domains); only then does the answer carry
 * `Access-Control-Allow-Origin` (that origin, never `*`, never credentials).
 * A request with any other Origin is refused before the body is read. A
 * request without an Origin (not a browser) is judged by the token alone.
 *
 * Neither the token nor the request URL reaches a log line.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { closeAfterResponse, createConsoleLogger, requestBodyStream, type Logger } from '@drobek/core';
import { dbErrorForLog, isQueryTimeout } from '@drobek/db';
import { AppsError } from './errors.js';
import type { HostConfig } from './host.js';
import { imageLimits, type ImageLimits } from './image.server.js';
import { isScreenshotRequestId, screenshotUploadMaxBytes } from './screenshots.js';
import { captureScreenshot, declineScreenshot, screenshotOriginAllowed, screenshotRequestStore, type ScreenshotRequestStore } from './screenshots.server.js';
import type { AppChangedEvent } from './events.js';

export interface ScreenshotUploadHandlerOptions {
  /** The catalogue hint for an error code (@drobek/agent-dx errorHint). */
  hint: (code: string) => string;
  store?: ScreenshotRequestStore;
  imageLimits?: ImageLimits;
  hosts?: HostConfig;
  verifiedDomain?: (appId: string, hostname: string) => Promise<boolean>;
  notify?: (event: AppChangedEvent) => Promise<void>;
  log?: Logger;
  now?: () => number;
}

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

function idOf(req: IncomingMessage): string {
  const path = (req.url ?? '').split('?')[0] ?? '';
  return path.slice(path.lastIndexOf('/') + 1);
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return typeof v === 'string' ? v : null;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** The request body up to `max` bytes; null past it (the rest is not read). */
async function readUpTo(req: IncomingMessage, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(header(req, 'content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of requestBodyStream(req)) {
    size += chunk.length;
    if (size > max) return null;
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return body;
}

function field(form: FormData, name: string): string | null {
  const v = form.get(name);
  return typeof v === 'string' ? v : null;
}

/** The node handler of `/api/screenshots/<request_id>` (see the file header). */
export function createScreenshotUploadHandler(opts: ScreenshotUploadHandlerOptions): NodeHandler {
  const store = opts.store ?? screenshotRequestStore();
  const log = opts.log ?? createConsoleLogger('screenshots');
  const now = opts.now ?? Date.now;

  function send(req: IncomingMessage, res: ServerResponse, status: number, body: Record<string, unknown> | null, cors: Record<string, string>): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (!req.complete) closeAfterResponse(req, res);
    res.writeHead(status, { ...BASE_HEADERS, ...cors, ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) });
    res.end(body ? JSON.stringify(body) : undefined);
  }

  /** The CORS headers for this request: {} without an Origin; null when the Origin may not answer this request. */
  async function corsFor(req: IncomingMessage, id: string): Promise<Record<string, string> | null> {
    const origin = header(req, 'origin');
    if (origin === null) return {};
    const pending = await store.get(id);
    if (!pending) return { Vary: 'Origin' };
    const ok = await screenshotOriginAllowed(origin, { id: pending.appId, slug: pending.slug }, { hosts: opts.hosts, verifiedDomain: opts.verifiedDomain });
    return ok ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, method: string, id: string, cors: Record<string, string>): Promise<void> {
    if (method === 'OPTIONS') {
      send(req, res, 204, null, {
        ...cors,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Max-Age': '600',
      });
      return;
    }
    const limits = opts.imageLimits ?? imageLimits();
    const raw = await readUpTo(req, screenshotUploadMaxBytes(limits.screenshotMaxBytes)).catch(() => {
      throw new Refusal(400, 'invalid_request', 'The upload did not arrive whole.');
    });
    if (raw === null) {
      throw new Refusal(413, 'payload_too_large', `The screenshot is larger than ${limits.screenshotMaxBytes} bytes (SCREENSHOT_MAX_BYTES).`);
    }
    let form: FormData;
    try {
      form = await new Response(raw, { headers: { 'content-type': header(req, 'content-type') ?? '' } }).formData();
    } catch {
      throw new Refusal(400, 'invalid_request', 'Send the answer as multipart/form-data with `token` and `screenshot` (or `action=decline`).');
    }
    const token = field(form, 'token');
    const action = field(form, 'action') ?? 'capture';
    const deps = { store, now, ...(opts.notify ? { notify: opts.notify } : {}) };
    if (action === 'decline') {
      await declineScreenshot({ id, token }, deps);
      send(req, res, 200, { status: 'declined' }, cors);
      return;
    }
    if (action !== 'capture') throw new Refusal(400, 'invalid_request', '`action` must be capture or decline.');
    const file = form.get('screenshot');
    if (file === null || typeof file === 'string') throw new Refusal(400, 'invalid_request', 'The upload carries no `screenshot` file.');
    const image = new Uint8Array(await file.arrayBuffer());
    const shot = await captureScreenshot(
      { id, token, image, path: field(form, 'path'), browser: field(form, 'browser') },
      { ...deps, imageLimits: limits }
    );
    send(req, res, 200, { status: 'ready', width: shot.width, height: shot.height }, cors);
  }

  return (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'POST' && method !== 'OPTIONS') {
      res.setHeader('Allow', 'POST, OPTIONS');
      send(req, res, 405, { code: 'method_not_allowed', message: 'Answer a screenshot request with POST.', hint: opts.hint('method_not_allowed') }, {});
      return;
    }
    let cors: Record<string, string> = {};
    const refuse = (status: number, code: string, message: string) => send(req, res, status, { code, message, hint: opts.hint(code) }, cors);
    void (async () => {
      const id = idOf(req);
      if (!isScreenshotRequestId(id)) throw new Refusal(404, 'not_found', 'There is no such screenshot request.');
      const allowed = await corsFor(req, id);
      if (allowed === null) throw new Refusal(403, 'forbidden', 'Only the app\'s own pages can answer its screenshot requests.');
      cors = allowed;
      await handle(req, res, method, id, cors);
    })().catch((err: unknown) => {
      if (err instanceof Refusal) return refuse(err.status, err.code, err.message);
      if (err instanceof AppsError) {
        if (err.code === 'not_found') return refuse(404, 'not_found', err.message);
        if (err.code === 'forbidden') return refuse(403, 'forbidden', err.message);
        if (err.code === 'too_large') return refuse(413, 'payload_too_large', err.message);
        if (err.code === 'invalid_image') return refuse(415, 'unsupported_media_type', err.message);
      }
      if (!req.complete && !req.readableEnded && req.destroyed) return;
      log.error('screenshot upload failed', { error: dbErrorForLog(err, { stack: true }) });
      if (isQueryTimeout(err)) return refuse(503, 'busy', 'The database did not answer in time; try again in a moment.');
      return refuse(500, 'internal_error', 'drobek hit an internal error while storing the screenshot.');
    });
  };
}
