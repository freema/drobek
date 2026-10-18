/**
 * The preview host's event stream: `GET /__drobek/preview/events` on
 * `<slug>--preview` answers a `text/event-stream` the preview script listens
 * to. Every message is a default (`message`) SSE event whose data is one JSON
 * object typed by `type`:
 *
 *   { type: 'ready', version }                       once, when the stream opens:
 *                                                   the newest compiled version (null = none)
 *   { type: 'version', version, compiled, errors }  a new version of the app was stored
 *                                                   (write_files, create_app, a restore, a copy)
 *   { type: 'screenshot_requested', request_id, token, note, expires_at }
 *                                                   an agent asked for a screenshot
 *                                                   (request_screenshot); also right after
 *                                                   `ready` for the newest request still open
 *   { type: 'screenshot_done', request_id }         a request was captured or declined
 *   : ping                                          every HEARTBEAT_MS
 *
 * The source is the `drobek:app-changed` feed: the in-process emitter, which
 * the serve-cache subscriber also relays every Redis message into, so a
 * version stored — or a screenshot asked for — by any drobek process reaches
 * every stream. One lookup of the version's compile result per event serves
 * every stream of the app. A screenshot request's token goes only to the
 * preview host's streams (it is what the page answers with).
 *
 * Slots: PREVIEW_EVENTS_MAX_PER_APP streams per app and
 * PREVIEW_EVENTS_MAX_PER_IP per client IP of an app in this process (over
 * either → 429); a stream ends after PREVIEW_EVENTS_MAX_MS (the browser
 * reconnects by itself). Every way a stream ends — the client leaving, its
 * lifetime, a slow reader, the server stopping (`endPreviewEvents`) — runs
 * one `close` that releases its slots and timers.
 */
import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { onLocalAppChanged, screenshotRequestStore, screenshotRequestedSignal, type AppChangedEvent, type ScreenshotSignal } from '@drobek/apps';
import { perIpLimitKey } from '@drobek/core';
import { appVersions, getDb } from '@drobek/db';
import type { AppRequest, AppResponse } from './handler.js';
import type { ServeApp, ServeVersion } from './store.server.js';

export const DEFAULT_PREVIEW_EVENTS_MAX_PER_APP = 50;
export const DEFAULT_PREVIEW_EVENTS_MAX_PER_IP = 4;
export const DEFAULT_PREVIEW_EVENTS_MAX_MS = 3_600_000;
const HEARTBEAT_MS = 25_000;
/** The browser's reconnect delay (the SSE `retry:` field). */
const RETRY_MS = 2000;
/** Unsent bytes a stream may hold for a client that reads too slowly; past it the stream ends. */
const MAX_BUFFERED_BYTES = 64 * 1024;
/** setTimeout's ceiling: a longer PREVIEW_EVENTS_MAX_MS would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

export interface PreviewEventLimits {
  maxPerApp: number;
  maxPerIp: number;
  maxMs: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** PREVIEW_EVENTS_MAX_PER_APP / _PER_IP / _MAX_MS (the defaults when unset or not a positive integer). */
export function previewEventLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): PreviewEventLimits {
  return {
    maxPerApp: positiveInt(env.PREVIEW_EVENTS_MAX_PER_APP, DEFAULT_PREVIEW_EVENTS_MAX_PER_APP),
    maxPerIp: positiveInt(env.PREVIEW_EVENTS_MAX_PER_IP, DEFAULT_PREVIEW_EVENTS_MAX_PER_IP),
    maxMs: positiveInt(env.PREVIEW_EVENTS_MAX_MS, DEFAULT_PREVIEW_EVENTS_MAX_MS),
  };
}

/** One message of the stream (the script dispatches on `type`). */
export type PreviewEvent =
  | { type: 'ready'; version: number | null }
  | { type: 'version'; version: number; compiled: boolean; errors: number }
  | { type: 'screenshot_requested'; request_id: string; token: string; note: string | null; expires_at: number }
  | { type: 'screenshot_done'; request_id: string };

/** The compile result of one stored version. */
export interface VersionCompile {
  compiled: boolean;
  errors: number;
}

export interface PreviewEventsOptions {
  /** The compile result of version `number` of the app (null = no such version). */
  compileOf?: (appId: string, number: number) => Promise<VersionCompile | null>;
  /** Subscribe to the app-changed feed (default: the in-process emitter). */
  listen?: (listener: (event: AppChangedEvent) => void) => () => void;
  /** The app's newest open screenshot request, sent to a stream when it opens (default: the Redis request store). */
  pendingScreenshot?: (appId: string) => Promise<ScreenshotSignal | null>;
  limits?: PreviewEventLimits;
  heartbeatMs?: number;
}

export type PreviewSubscribeResult =
  | { ok: true; stream: Readable }
  | { ok: false; reason: 'limit'; limit: 'PREVIEW_EVENTS_MAX_PER_APP' | 'PREVIEW_EVENTS_MAX_PER_IP'; value: number }
  | { ok: false; reason: 'ending' };

interface Sub {
  appId: string;
  stream: Readable;
  closed: boolean;
  close(): void;
}

function frame(event: PreviewEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function screenshotFrame(s: ScreenshotSignal): string {
  return frame(
    s.state === 'requested'
      ? { type: 'screenshot_requested', request_id: s.request_id, token: s.token, note: s.note, expires_at: s.expires_at }
      : { type: 'screenshot_done', request_id: s.request_id }
  );
}

/** The newest unanswered, unexpired request of the app in the Redis store. */
async function pendingFromStore(appId: string): Promise<ScreenshotSignal | null> {
  const [newest] = await screenshotRequestStore().pending(appId, Date.now());
  return newest ? screenshotRequestedSignal(newest) : null;
}

/** The compile result of a version, from Postgres. */
async function compileFromDb(appId: string, number: number): Promise<VersionCompile | null> {
  const [row] = await getDb()
    .select({ status: appVersions.compileStatus, errors: appVersions.compileErrors })
    .from(appVersions)
    .where(and(eq(appVersions.appId, appId), eq(appVersions.number, number)))
    .limit(1);
  if (!row) return null;
  return { compiled: row.status === 'ok', errors: Array.isArray(row.errors) ? row.errors.length : 0 };
}

export class PreviewEventsHub {
  private readonly byApp = new Map<string, Set<Sub>>();
  private readonly perIp = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  private off: (() => void) | null = null;
  private ending = false;
  readonly limits: PreviewEventLimits;

  constructor(private readonly opts: PreviewEventsOptions = {}) {
    this.limits = opts.limits ?? previewEventLimitsFromEnv();
  }

  /** Open streams (all, or of one app). */
  open(appId?: string): number {
    if (appId !== undefined) return this.byApp.get(appId)?.size ?? 0;
    let n = 0;
    for (const s of this.byApp.values()) n += s.size;
    return n;
  }

  /** A new stream of `appId` for a client at `clientIp`; `current` = the newest compiled version now. */
  subscribe(input: { appId: string; clientIp: string | null; current: number | null }): PreviewSubscribeResult {
    if (this.ending) return { ok: false, reason: 'ending' };
    const { appId } = input;
    const subs = this.byApp.get(appId) ?? new Set<Sub>();
    if (subs.size >= this.limits.maxPerApp) {
      return { ok: false, reason: 'limit', limit: 'PREVIEW_EVENTS_MAX_PER_APP', value: this.limits.maxPerApp };
    }
    const ip = perIpLimitKey(input.clientIp, 'preview-events');
    const ipSlot = ip === null ? null : `${appId}:${ip}`;
    const ipCount = ipSlot ? (this.perIp.get(ipSlot) ?? 0) : 0;
    if (ipSlot && ipCount >= this.limits.maxPerIp) {
      return { ok: false, reason: 'limit', limit: 'PREVIEW_EVENTS_MAX_PER_IP', value: this.limits.maxPerIp };
    }
    if (ipSlot) this.perIp.set(ipSlot, ipCount + 1);
    this.byApp.set(appId, subs);

    const timers: NodeJS.Timeout[] = [];
    const stream = new Readable({ read() {} });
    const sub: Sub = {
      appId,
      stream,
      closed: false,
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        for (const t of timers) clearTimeout(t);
        const set = this.byApp.get(appId);
        set?.delete(sub);
        if (set && set.size === 0) this.byApp.delete(appId);
        if (ipSlot) {
          const left = (this.perIp.get(ipSlot) ?? 1) - 1;
          if (left > 0) this.perIp.set(ipSlot, left);
          else this.perIp.delete(ipSlot);
        }
        if (this.byApp.size === 0 && this.off) {
          this.off();
          this.off = null;
        }
        if (!stream.destroyed) stream.push(null);
      },
    };
    subs.add(sub);
    stream.on('close', sub.close);
    stream.on('error', sub.close);
    timers.push(setInterval(() => this.write(sub, ': ping\n\n'), this.opts.heartbeatMs ?? HEARTBEAT_MS));
    timers.push(setTimeout(sub.close, Math.min(this.limits.maxMs, MAX_TIMER_MS)));
    for (const t of timers) t.unref?.();

    this.off ??= (this.opts.listen ?? onLocalAppChanged)((e) => this.onChanged(e));
    this.write(sub, `retry: ${RETRY_MS}\n\n`);
    this.write(sub, frame({ type: 'ready', version: input.current }));
    void (this.opts.pendingScreenshot ?? pendingFromStore)(appId)
      .then((s) => {
        if (s) this.write(sub, screenshotFrame(s));
      })
      .catch(() => undefined);
    return { ok: true, stream };
  }

  /** End every stream and refuse new ones (the server stops). */
  endAll(): void {
    this.ending = true;
    for (const subs of [...this.byApp.values()]) for (const s of [...subs]) s.close();
  }

  private onChanged(e: AppChangedEvent): void {
    if (e.kind === 'screenshot') {
      if (!e.screenshot) return;
      const text = screenshotFrame(e.screenshot);
      for (const sub of [...(this.byApp.get(e.app_id) ?? [])]) this.write(sub, text);
      return;
    }
    if (e.kind !== undefined && e.kind !== 'version') return;
    if (typeof e.version !== 'number' || !this.byApp.has(e.app_id)) return;
    const appId = e.app_id;
    const n = e.version;
    const next = (this.queues.get(appId) ?? Promise.resolve())
      .then(() => this.dispatch(appId, n))
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(appId) === next) this.queues.delete(appId);
      });
    this.queues.set(appId, next);
  }

  private async dispatch(appId: string, number: number): Promise<void> {
    const compileOf = this.opts.compileOf ?? compileFromDb;
    const result = await compileOf(appId, number);
    if (!result) return;
    const text = frame({ type: 'version', version: number, compiled: result.compiled, errors: result.errors });
    for (const sub of [...(this.byApp.get(appId) ?? [])]) this.write(sub, text);
  }

  private write(sub: Sub, text: string): void {
    if (sub.closed) return;
    if (sub.stream.readableLength > MAX_BUFFERED_BYTES) {
      sub.close();
      return;
    }
    sub.stream.push(text);
  }
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** The answer to `GET /__drobek/preview/events`: the stream, or 429 / 503 JSON when no slot is free. */
export function previewEventsResponse(hub: PreviewEventsHub, req: AppRequest, app: ServeApp, version: ServeVersion | null): AppResponse {
  const r = hub.subscribe({ appId: app.id, clientIp: req.clientIp, current: version?.number ?? null });
  if (r.ok) {
    return {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
      body: r.stream,
    };
  }
  if (r.reason === 'ending') {
    return {
      status: 503,
      headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store', 'Retry-After': '5' },
      body: JSON.stringify({ error: 'unavailable', message: 'The server is restarting; the preview reconnects by itself.' }),
    };
  }
  return {
    status: 429,
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store', 'Retry-After': '60' },
    body: JSON.stringify({
      error: 'limit_exceeded',
      message: `Too many live previews of this app are open (at most ${r.value}); this page will not reload by itself.`,
      details: { limit: r.limit, value: r.value },
    }),
  };
}

let hub: PreviewEventsHub | null = null;

/** The process's hub (ended by the server's graceful stop). */
export function previewEventsHub(): PreviewEventsHub {
  hub ??= new PreviewEventsHub();
  return hub;
}

/** The graceful stop: end every preview stream and refuse new ones. */
export function endPreviewEvents(): void {
  previewEventsHub().endAll();
}
