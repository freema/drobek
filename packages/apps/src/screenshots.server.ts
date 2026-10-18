/**
 * Screenshots an agent asks for: `request_screenshot` stores a request, the
 * app's open previews show it, a person captures the page (or declines), and
 * `get_screenshot` hands the image to the agent. Nothing is rendered on the
 * server; nothing is captured without a person's click.
 *
 * A request lives in Redis only: `drobek:screenshot:<id>` holds `{ app,
 * version, note, token, expires_at, state }` for SCREENSHOT_REQUEST_TTL_SEC
 * plus a day (so `expired` and `declined` still answer for a while), the
 * per-app sorted set `drobek:screenshot:pending:<app_id>` lets a preview that
 * opens later still see it, and `drobek:screenshot:claim:<id>` (until the
 * expiry) is the one-time claim: the token works once — the first answer
 * deletes the claim key (DEL = 1), every later one finds it gone. The token
 * is 32 random bytes, sent only to the preview tabs (the event stream) and
 * compared in constant time; it is never logged or audited.
 *
 * A captured image is re-encoded like a feedback screenshot (image.server.ts —
 * never stored as uploaded) into a WebP in `blobs`; `app_screenshots` keeps
 * the request id, version, page, note and size. Rows older than
 * SCREENSHOTS_RETENTION_DAYS are deleted by the hourly blob job, whose sweep
 * then frees the bytes. Audited: `app.screenshot.request` (the agent),
 * `app.screenshot.capture` and `app.screenshot.decline` (the person on the
 * preview — anonymous: the app host carries no dashboard credential).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { getRedis, hitFixedWindow } from '@drobek/core';
import { appScreenshots, blobs, domains, getDb, users } from '@drobek/db';
import { AppsError } from './errors.js';
import { notifyAppChanged, type AppChangedEvent, type ScreenshotSignal } from './events.js';
import { normalizeFeedbackPath } from './feedback.js';
import { classifyHost, type HostConfig } from './host.js';
import { imageLimits, reencodeScreenshot, type ImageLimits } from './image.server.js';
import { hostConfig } from './origin.js';
import { SCREENSHOT_LIST_MAX, screenshotBrowser, screenshotLimits, validateScreenshotNote, type ScreenshotLimits } from './screenshots.js';
import type { Actor } from './types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How long an answered or expired request still answers its state. */
const KEEP_AFTER_MS = DAY_MS;

export type ScreenshotRequestState = 'pending' | 'declined' | 'captured';

export interface ScreenshotRequest {
  id: string;
  appId: string;
  slug: string;
  workspaceId: string;
  /** The preview's version when the agent asked (null = nothing had compiled). */
  version: number | null;
  note: string | null;
  /** The one-time token the preview answers with. */
  token: string;
  requestedBy: string | null;
  /** Epoch ms. */
  requestedAt: number;
  /** Epoch ms. */
  expiresAt: number;
  state: ScreenshotRequestState;
}

export interface ScreenshotRequestStore {
  /** Store a new request, kept `keepMs`; its claim lasts until `expiresAt`. */
  create(req: ScreenshotRequest, keepMs: number, now: number): Promise<void>;
  get(id: string): Promise<ScreenshotRequest | null>;
  /** The one-time claim: true for exactly one caller while the request is unexpired. */
  claim(id: string): Promise<boolean>;
  /** Write an answered request's new state (it keeps its keep time) and drop it from the pending set. */
  settle(req: ScreenshotRequest): Promise<void>;
  /** The app's unanswered, unexpired requests, newest first. */
  pending(appId: string, now: number): Promise<ScreenshotRequest[]>;
  /** Count one request of the app in the hourly window (SCREENSHOT_REQUESTS_PER_APP_HOUR). */
  hit(appId: string): Promise<{ count: number; ttlMs: number }>;
}

const KEY = 'drobek:screenshot:';
const CLAIM_KEY = 'drobek:screenshot:claim:';
const PENDING_KEY = 'drobek:screenshot:pending:';
const RATE_KEY = 'drobek:rl:screenshot-request:';

function parseRequest(raw: string | null): ScreenshotRequest | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<ScreenshotRequest>;
    if (typeof r.id !== 'string' || typeof r.appId !== 'string' || typeof r.token !== 'string' || typeof r.expiresAt !== 'number') return null;
    return r as ScreenshotRequest;
  } catch {
    return null;
  }
}

/** The production store (Redis). */
export function redisScreenshotRequestStore(redis: () => ReturnType<typeof getRedis> = getRedis): ScreenshotRequestStore {
  return {
    async create(req, keepMs, now) {
      const r = redis();
      await r
        .multi()
        .set(`${KEY}${req.id}`, JSON.stringify(req), 'PX', keepMs)
        .set(`${CLAIM_KEY}${req.id}`, '1', 'PX', Math.max(req.expiresAt - now, 1))
        .zadd(`${PENDING_KEY}${req.appId}`, req.expiresAt, req.id)
        .zremrangebyscore(`${PENDING_KEY}${req.appId}`, '-inf', now)
        .pexpire(`${PENDING_KEY}${req.appId}`, keepMs)
        .exec();
    },
    async get(id) {
      return parseRequest(await redis().get(`${KEY}${id}`));
    },
    async claim(id) {
      return (await redis().del(`${CLAIM_KEY}${id}`)) === 1;
    },
    async settle(req) {
      await redis().multi().set(`${KEY}${req.id}`, JSON.stringify(req), 'KEEPTTL').zrem(`${PENDING_KEY}${req.appId}`, req.id).exec();
    },
    async pending(appId, now) {
      const ids = await redis().zrevrangebyscore(`${PENDING_KEY}${appId}`, '+inf', `(${now}`);
      if (ids.length === 0) return [];
      const rows = await redis().mget(...ids.map((id) => `${KEY}${id}`));
      return rows.map(parseRequest).filter((r): r is ScreenshotRequest => r !== null && r.state === 'pending' && r.expiresAt > now);
    },
    async hit(appId) {
      return hitFixedWindow(redis(), `${RATE_KEY}${appId}`, HOUR_MS);
    },
  };
}

/** An in-memory store on a clock (tests). */
export function memoryScreenshotRequestStore(clock: () => number = Date.now): ScreenshotRequestStore {
  const records = new Map<string, { json: string; until: number }>();
  const claims = new Map<string, number>();
  const hits = new Map<string, { count: number; until: number }>();
  const live = (id: string) => {
    const e = records.get(id);
    return e && e.until > clock() ? parseRequest(e.json) : null;
  };
  return {
    async create(req, keepMs, now) {
      records.set(req.id, { json: JSON.stringify(req), until: now + keepMs });
      claims.set(req.id, req.expiresAt);
    },
    async get(id) {
      return live(id);
    },
    async claim(id) {
      const until = claims.get(id);
      claims.delete(id);
      return until !== undefined && until > clock();
    },
    async settle(req) {
      const e = records.get(req.id);
      if (e) records.set(req.id, { json: JSON.stringify(req), until: e.until });
    },
    async pending(appId, now) {
      const out: ScreenshotRequest[] = [];
      for (const id of records.keys()) {
        const r = live(id);
        if (r && r.appId === appId && r.state === 'pending' && r.expiresAt > now) out.push(r);
      }
      return out.sort((a, b) => b.expiresAt - a.expiresAt);
    },
    async hit(appId) {
      const now = clock();
      const e = hits.get(appId);
      const next = e && e.until > now ? { count: e.count + 1, until: e.until } : { count: 1, until: now + HOUR_MS };
      hits.set(appId, next);
      return { count: next.count, ttlMs: next.until - now };
    },
  };
}

let defaultStore: ScreenshotRequestStore | null = null;

/** The process's Redis store. */
export function screenshotRequestStore(): ScreenshotRequestStore {
  defaultStore ??= redisScreenshotRequestStore();
  return defaultStore;
}

/** The app-changed event that tells the app's preview tabs about a request (or that it was answered). */
export function screenshotEvent(req: Pick<ScreenshotRequest, 'appId' | 'slug'>, screenshot: ScreenshotSignal): AppChangedEvent {
  return { app_id: req.appId, slug: req.slug, kind: 'screenshot', screenshot };
}

/** The `requested` signal of a pending request (what a preview tab needs to show and answer it). */
export function screenshotRequestedSignal(req: ScreenshotRequest): ScreenshotSignal {
  return { state: 'requested', request_id: req.id, token: req.token, note: req.note, expires_at: req.expiresAt };
}

type Notify = (event: AppChangedEvent) => Promise<void>;

export interface ScreenshotDeps {
  store?: ScreenshotRequestStore;
  now?: () => number;
  limits?: ScreenshotLimits;
  /** Tells the app's preview tabs (default: notifyAppChanged — this process and Redis). */
  notify?: Notify;
}

/**
 * Ask the app's open previews for a screenshot. Refuses `invalid_settings`
 * for a note over SCREENSHOT_NOTE_MAX and `rate_limited` past
 * SCREENSHOT_REQUESTS_PER_APP_HOUR. Audited `app.screenshot.request` (the
 * request id and version, never the note).
 */
export async function requestScreenshot(
  input: { app: { id: string; slug: string; workspaceId: string }; version: number | null; note?: unknown; actor: Actor },
  deps: ScreenshotDeps = {}
): Promise<ScreenshotRequest> {
  const note = validateScreenshotNote(input.note);
  if (!note.ok) throw new AppsError('invalid_settings', note.message);
  const store = deps.store ?? screenshotRequestStore();
  const limits = deps.limits ?? screenshotLimits();
  const now = (deps.now ?? Date.now)();
  const hit = await store.hit(input.app.id);
  if (hit.count > limits.requestsPerAppHour) {
    const retry = Math.max(1, Math.ceil(hit.ttlMs / 1000));
    throw new AppsError(
      'rate_limited',
      `This app was asked for ${limits.requestsPerAppHour} screenshots within the last hour, the most it may be (SCREENSHOT_REQUESTS_PER_APP_HOUR). Wait ${retry} seconds, or ask the user to describe what they see.`,
      { details: { limit: 'SCREENSHOT_REQUESTS_PER_APP_HOUR', value: limits.requestsPerAppHour, retry_after_seconds: retry } }
    );
  }
  const req: ScreenshotRequest = {
    id: `ss_${randomBytes(12).toString('hex')}`,
    appId: input.app.id,
    slug: input.app.slug,
    workspaceId: input.app.workspaceId,
    version: input.version,
    note: note.note,
    token: randomBytes(32).toString('base64url'),
    requestedBy: input.actor.userId,
    requestedAt: now,
    expiresAt: now + limits.requestTtlSec * 1000,
    state: 'pending',
  };
  await store.create(req, limits.requestTtlSec * 1000 + KEEP_AFTER_MS, now);
  await writeAudit({
    workspaceId: input.app.workspaceId,
    actorUserId: input.actor.userId,
    actorKind: input.actor.kind,
    action: AUDIT_ACTIONS.appScreenshotRequest,
    subjectType: 'app',
    target: input.app.slug,
    meta: { appId: input.app.id, request: req.id, ...(input.version !== null ? { version: input.version } : {}) },
  });
  await (deps.notify ?? notifyAppChanged)(screenshotEvent(req, screenshotRequestedSignal(req)));
  return req;
}

/** A captured screenshot as the lists show it (the bytes are read on their own, getAppScreenshot). */
export interface AppScreenshotInfo {
  id: string;
  appId: string;
  versionNumber: number | null;
  path: string | null;
  note: string | null;
  requestedByEmail: string | null;
  browser: string | null;
  width: number;
  height: number;
  bytes: number;
  requestedAt: Date;
  capturedAt: Date;
}

export interface AppScreenshot extends AppScreenshotInfo {
  /** The stored WebP. */
  data: Buffer;
  mimeType: 'image/webp';
}

function selectScreenshots() {
  return getDb()
    .select({
      id: appScreenshots.id,
      appId: appScreenshots.appId,
      versionNumber: appScreenshots.versionNumber,
      path: appScreenshots.path,
      note: appScreenshots.note,
      requestedByEmail: users.email,
      browser: appScreenshots.browser,
      width: appScreenshots.width,
      height: appScreenshots.height,
      bytes: appScreenshots.bytes,
      requestedAt: appScreenshots.requestedAt,
      capturedAt: appScreenshots.capturedAt,
    })
    .from(appScreenshots)
    .leftJoin(users, eq(users.id, appScreenshots.requestedByUserId));
}

function infoOf<T extends { requestedByEmail: string | null }>(r: T): T {
  return { ...r, requestedByEmail: r.requestedByEmail ?? null };
}

/** The app's captured screenshots, newest first (at most `limit`, ≤ SCREENSHOT_LIST_MAX). */
export async function listAppScreenshots(appId: string, opts: { limit?: number } = {}): Promise<AppScreenshotInfo[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), SCREENSHOT_LIST_MAX);
  const rows = await selectScreenshots()
    .where(eq(appScreenshots.appId, appId))
    .orderBy(desc(appScreenshots.capturedAt), desc(appScreenshots.id))
    .limit(limit);
  return rows.map(infoOf);
}

/** One captured screenshot of the app with its bytes, or null. */
export async function getAppScreenshot(appId: string, id: string): Promise<AppScreenshot | null> {
  const [row] = await getDb()
    .select({ sha256: appScreenshots.sha256, data: blobs.bytes })
    .from(appScreenshots)
    .innerJoin(blobs, eq(blobs.sha256, appScreenshots.sha256))
    .where(and(eq(appScreenshots.appId, appId), eq(appScreenshots.id, id)))
    .limit(1);
  if (!row) return null;
  const [info] = await selectScreenshots()
    .where(and(eq(appScreenshots.appId, appId), eq(appScreenshots.id, id)))
    .limit(1);
  if (!info) return null;
  return { ...infoOf(info), data: Buffer.from(row.data), mimeType: 'image/webp' };
}

/** Where a request stands, with the app it belongs to (to authorize the reader). */
export type ScreenshotLookup =
  | { state: 'ready'; appId: string; screenshot: AppScreenshotInfo }
  | { state: 'pending' | 'expired' | 'declined'; appId: string; request: ScreenshotRequest };

/** The state of request `id`: ready (captured and still kept), pending, expired, declined — or null when unknown or long gone. */
export async function lookupScreenshot(id: string, deps: Pick<ScreenshotDeps, 'store' | 'now'> = {}): Promise<ScreenshotLookup | null> {
  const [row] = await selectScreenshots().where(eq(appScreenshots.id, id)).limit(1);
  if (row) return { state: 'ready', appId: row.appId, screenshot: infoOf(row) };
  const req = await (deps.store ?? screenshotRequestStore()).get(id);
  if (!req) return null;
  const now = (deps.now ?? Date.now)();
  if (req.state === 'declined') return { state: 'declined', appId: req.appId, request: req };
  if (req.state === 'captured') return { state: 'expired', appId: req.appId, request: req };
  return { state: req.expiresAt > now ? 'pending' : 'expired', appId: req.appId, request: req };
}

function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || given.length === 0 || given.length > 128) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The request `id` while it can still be answered with `token`: refuses
 * `not_found` when it is unknown, answered or expired, `forbidden` for a
 * wrong token. Does not use the token up.
 */
export async function openScreenshotRequest(id: string, token: unknown, deps: Pick<ScreenshotDeps, 'store' | 'now'> = {}): Promise<ScreenshotRequest> {
  const req = await (deps.store ?? screenshotRequestStore()).get(id);
  const now = (deps.now ?? Date.now)();
  if (!req || req.state !== 'pending' || req.expiresAt <= now) {
    throw new AppsError('not_found', 'This screenshot request is unknown, already answered or expired — the agent can ask again.');
  }
  if (!tokenMatches(req.token, token)) throw new AppsError('forbidden', 'This screenshot request was answered with a wrong token.');
  return req;
}

const GONE = 'This screenshot request was answered a moment ago, or it has just expired.';

/**
 * Store the screenshot a person took for request `id` (token checked, image
 * re-encoded, then the one-time claim). Refuses like openScreenshotRequest,
 * `too_large` over SCREENSHOT_MAX_BYTES and `invalid_image` for bytes that are
 * not a PNG, JPEG or WebP that decodes — those two leave the request open for
 * another try. Audited `app.screenshot.capture`.
 */
export async function captureScreenshot(
  input: { id: string; token: unknown; image: Uint8Array; path?: unknown; browser?: unknown },
  deps: ScreenshotDeps & { imageLimits?: ImageLimits } = {}
): Promise<AppScreenshotInfo> {
  const store = deps.store ?? screenshotRequestStore();
  const req = await openScreenshotRequest(input.id, input.token, { store, now: deps.now });
  const imgLimits = deps.imageLimits ?? imageLimits();
  if (input.image.byteLength === 0) throw new AppsError('invalid_image', 'The upload carries no screenshot.');
  if (input.image.byteLength > imgLimits.screenshotMaxBytes) {
    throw new AppsError('too_large', `The screenshot is larger than ${imgLimits.screenshotMaxBytes} bytes (SCREENSHOT_MAX_BYTES).`, {
      details: { limit: 'SCREENSHOT_MAX_BYTES', value: imgLimits.screenshotMaxBytes },
    });
  }
  const shot = await reencodeScreenshot(input.image, imgLimits);
  const sha256 = createHash('sha256').update(shot.bytes).digest('hex');
  if (!(await store.claim(req.id))) throw new AppsError('not_found', GONE);
  const path = input.path === undefined || input.path === null || input.path === '' ? null : normalizeFeedbackPath(input.path);
  const browser = screenshotBrowser(input.browser);
  await getDb().transaction(async (tx) => {
    await tx
      .insert(blobs)
      .values({ sha256, bytes: shot.bytes, size: shot.bytes.length })
      .onConflictDoUpdate({ target: blobs.sha256, set: { createdAt: sql`now()` } });
    await tx.insert(appScreenshots).values({
      id: req.id,
      appId: req.appId,
      versionNumber: req.version,
      path,
      note: req.note,
      requestedByUserId: req.requestedBy,
      browser,
      sha256,
      width: shot.width,
      height: shot.height,
      bytes: shot.bytes.length,
      requestedAt: new Date(req.requestedAt),
      capturedAt: new Date((deps.now ?? Date.now)()),
    });
    await writeAudit(
      {
        workspaceId: req.workspaceId,
        actorUserId: null,
        actorKind: 'user',
        action: AUDIT_ACTIONS.appScreenshotCapture,
        subjectType: 'app',
        target: req.slug,
        meta: { appId: req.appId, request: req.id, ...(req.version !== null ? { version: req.version } : {}), browser },
      },
      tx
    );
  });
  await store.settle({ ...req, state: 'captured' });
  await (deps.notify ?? notifyAppChanged)(screenshotEvent(req, { state: 'done', request_id: req.id }));
  const [row] = await selectScreenshots().where(eq(appScreenshots.id, req.id)).limit(1);
  return infoOf(row!);
}

/** The person on the preview said "Not now" to request `id`. Refuses like openScreenshotRequest. Audited `app.screenshot.decline`. */
export async function declineScreenshot(input: { id: string; token: unknown }, deps: ScreenshotDeps = {}): Promise<void> {
  const store = deps.store ?? screenshotRequestStore();
  const req = await openScreenshotRequest(input.id, input.token, { store, now: deps.now });
  if (!(await store.claim(req.id))) throw new AppsError('not_found', GONE);
  await store.settle({ ...req, state: 'declined' });
  await writeAudit({
    workspaceId: req.workspaceId,
    actorUserId: null,
    actorKind: 'user',
    action: AUDIT_ACTIONS.appScreenshotDecline,
    subjectType: 'app',
    target: req.slug,
    meta: { appId: req.appId, request: req.id, ...(req.version !== null ? { version: req.version } : {}) },
  });
  await (deps.notify ?? notifyAppChanged)(screenshotEvent(req, { state: 'done', request_id: req.id }));
}

/**
 * May a browser page at `origin` answer a request of app `app`? Only the
 * app's own hosts: `<slug>`, `<slug>--preview` and `<slug>--v<N>` under
 * APPS_DOMAIN (scheme and port as the apps origin), and the app's verified
 * custom domains.
 */
export async function screenshotOriginAllowed(
  origin: string,
  app: { id: string; slug: string },
  opts: { hosts?: HostConfig; verifiedDomain?: (appId: string, hostname: string) => Promise<boolean> } = {}
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin) return false;
  const cls = classifyHost(url.host, opts.hosts ?? hostConfig());
  if (cls.side === 'apps') return cls.target?.slug === app.slug;
  if (cls.side === 'custom') return url.protocol === 'https:' && (await (opts.verifiedDomain ?? isVerifiedDomainOf)(app.id, cls.hostname));
  return false;
}

async function isVerifiedDomainOf(appId: string, hostname: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.appId, appId), eq(domains.hostname, hostname), isNotNull(domains.verifiedAt)))
    .limit(1);
  return row !== undefined;
}

/** Delete the screenshots captured more than SCREENSHOTS_RETENTION_DAYS ago; the blob GC frees the bytes. Returns how many went. */
export async function pruneOldScreenshots(opts: { retentionDays?: number; now?: Date } = {}): Promise<number> {
  const days = opts.retentionDays ?? screenshotLimits().retentionDays;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - days * DAY_MS);
  const rows = await getDb().delete(appScreenshots).where(lt(appScreenshots.capturedAt, cutoff)).returning({ id: appScreenshots.id });
  return rows.length;
}
