/**
 * App traffic analytics — the pure rules (no Redis, no database):
 *
 *  - which response is a page view: the serving handler calls the recorder only
 *    for a successful (200 / 304) GET of an HTML document on the production
 *    host or a custom domain; `classifyPageView` then drops what is not a
 *    person opening a page (drobek's own checks, prefetches, a fetch() of the
 *    HTML, the dashboard's app thumbnail) and tells bots apart by user agent;
 *  - the referrer: only the host of an external referrer, never its path or
 *    query;
 *  - the env switches (ANALYTICS_ENABLED, ANALYTICS_RETENTION_DAYS) and the
 *    read model's shape (a zero-filled daily series, totals, top lists).
 */
import { daysBetween } from './logs.js';

/** Distinct paths and referrer hosts counted per app and day; the rest count as `__other__`. */
export const TRAFFIC_TOP_KEYS_MAX = 200;
export const TRAFFIC_OTHER = '__other__';
/** The ranges the Analytics tab offers (days). */
export const TRAFFIC_RANGES = [7, 30, 90] as const;
export const DEFAULT_ANALYTICS_RETENTION_DAYS = 90;
/** Entries of each top list a read returns by default. */
export const TRAFFIC_TOP_LIMIT = 10;

const MAX_PATH_LEN = 256;
const MAX_HOST_LEN = 253;
const DAY_MS = 86_400_000;

/** ANALYTICS_ENABLED (default on; `0` / `false` / `off` turns counting and the reads off). */
export function analyticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ANALYTICS_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/** ANALYTICS_RETENTION_DAYS (default 90; a positive integer, at most 3650). */
export function analyticsRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ANALYTICS_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ANALYTICS_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 3650 ? n : DEFAULT_ANALYTICS_RETENTION_DAYS;
}

/**
 * User agents of crawlers, link previews, monitors, headless browsers and HTTP
 * libraries. An empty user agent is a bot too. The list is deliberately
 * simple: a person's browser never names any of these.
 */
const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|archiver|facebookexternalhit|facebookcatalog|embedly|quora link preview|whatsapp|skypeuripreview|vkshare|preview|w3c_validator|validator\.nu|lighthouse|pagespeed|gtmetrix|pingdom|uptime|statuscake|site24x7|monitor|headlesschrome|phantomjs|puppeteer|playwright|selenium|webdriver|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|apache-httpclient|libwww|wget|curl\/|node-fetch|axios|undici|scrapy|feedfetcher|mediapartners|semrush|ahrefs|mj12|petalbot|yandex|baiduspider|gptbot|ccbot|claude|anthropic|perplexity|bytespider|amazonbot|applebot|duckduckbot|google-inspectiontool|google-extended/i;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  const s = (ua ?? '').trim();
  return s === '' || BOT_UA.test(s);
}

/** drobek's own requests (health and smoke checks) name themselves `drobek-…` and are never counted. */
function isInternalUserAgent(ua: string | null | undefined): boolean {
  return /^drobek[-/]/i.test((ua ?? '').trim());
}

/** `host[:port]` → the lower-cased hostname. */
function hostnameOf(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1) || null;
  const i = h.indexOf(':');
  return (i === -1 ? h : h.slice(0, i)) || null;
}

/**
 * The host of an EXTERNAL referrer — null for none, an unparsable one, a
 * non-http(s) one, an IP literal of v6, or one on the requested host itself
 * (navigation inside the app). Never the path, query or fragment.
 */
export function referrerHost(referer: string | null | undefined, requestHost: string | null | undefined): string | null {
  if (!referer) return null;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > MAX_HOST_LEN || !/^[a-z0-9.-]+$/.test(host)) return null;
  if (host === hostnameOf(requestHost)?.replace(/\.$/, '')) return null;
  return host;
}

/** A page path as counted: no query or fragment, a leading slash, at most 256 characters. */
export function trafficPath(path: string | null | undefined): string {
  if (!path) return '/';
  let p = path.split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = `/${p}`;
  return p.slice(0, MAX_PATH_LEN);
}

/** What the serving handler knows about a successful HTML document response. */
export interface PageViewInput {
  /** The request path (no query). */
  path: string;
  /** The Host header (the production host or a custom domain). */
  host: string | null;
  userAgent: string | null;
  referer: string | null;
  clientIp: string | null;
  /** `Sec-Fetch-Dest` (absent on old browsers and non-browser clients). */
  secFetchDest: string | null;
  /** `Sec-Purpose` / `Purpose` (a prefetch or prerender says so). */
  purpose: string | null;
  /**
   * Origins whose frames of the app are not visits: the dashboard (its app
   * thumbnail) and the operator's gallery website (its scaled-down live preview).
   */
  frameOrigins?: readonly string[];
}

export type PageViewClass = 'human' | 'bot' | 'skip';

const DOCUMENT_DESTS = new Set(['document', 'iframe', 'frame']);

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a page view is counted, and as a person or a bot. A frame counts
 * only when the embedding page sent its address and is not one of
 * `frameOrigins`: the dashboard's thumbnail is sent without a referrer.
 */
export function classifyPageView(input: PageViewInput): PageViewClass {
  if (isInternalUserAgent(input.userAgent)) return 'skip';
  if (input.purpose && /prefetch|prerender/i.test(input.purpose)) return 'skip';
  const dest = input.secFetchDest?.trim().toLowerCase();
  if (dest && !DOCUMENT_DESTS.has(dest)) return 'skip';
  if (dest === 'iframe' || dest === 'frame') {
    if (!input.referer) return 'skip';
    const origin = originOf(input.referer);
    if (origin === null || (input.frameOrigins ?? []).some((o) => originOf(o) === origin)) return 'skip';
  }
  return isBotUserAgent(input.userAgent) ? 'bot' : 'human';
}

// ── the read model ───────────────────────────────────────────────────────────

export interface TrafficDay {
  day: string;
  views: number;
  visitors: number;
  bot_views: number;
}

export interface TrafficTopPath {
  path: string;
  views: number;
}

export interface TrafficTopReferrer {
  host: string;
  views: number;
}

/** The traffic of one app over a range of UTC days (both ends included). */
export interface TrafficView {
  days: number;
  from: string;
  to: string;
  /** One entry per day of the range, oldest first, zero-filled. */
  series: TrafficDay[];
  totals: {
    views: number;
    /** The sum of the daily unique-visitor estimates (one person on 3 days counts 3 times). */
    visitors: number;
    bot_views: number;
    /** bot_views / (views + bot_views), 0–1 with 3 decimals; null without any view. */
    bot_share: number | null;
  };
  top_paths: TrafficTopPath[];
  top_referrers: TrafficTopReferrer[];
}

/** The first and last day of a range of `days` days ending today (UTC). */
export function trafficRange(days: number, now: Date = new Date()): { from: string; to: string; days: string[] } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  return { from, to, days: daysBetween(from, to) };
}

/** Clamp a requested range to 1…retention days (default 30, or 7 when the retention is shorter). */
export function clampTrafficDays(days: unknown, retentionDays: number, fallback = 30): number {
  const n = typeof days === 'number' && Number.isInteger(days) ? days : Math.min(fallback, retentionDays);
  return Math.max(1, Math.min(n, retentionDays));
}

function topList(counts: Map<string, number>, limit: number): [string, number][] {
  return [...counts.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit);
}

/** The view of a range: `daily` per day (missing days are zero), `paths` / `referrers` summed over the range. */
export function shapeTraffic(input: {
  range: { from: string; to: string; days: string[] };
  daily: Map<string, { views: number; visitors: number; botViews: number }>;
  paths: Map<string, number>;
  referrers: Map<string, number>;
  topLimit?: number;
}): TrafficView {
  const series = input.range.days.map((day) => {
    const d = input.daily.get(day);
    return { day, views: d?.views ?? 0, visitors: d?.visitors ?? 0, bot_views: d?.botViews ?? 0 };
  });
  const views = series.reduce((n, d) => n + d.views, 0);
  const visitors = series.reduce((n, d) => n + d.visitors, 0);
  const botViews = series.reduce((n, d) => n + d.bot_views, 0);
  const all = views + botViews;
  const limit = input.topLimit ?? TRAFFIC_TOP_LIMIT;
  return {
    days: series.length,
    from: input.range.from,
    to: input.range.to,
    series,
    totals: { views, visitors, bot_views: botViews, bot_share: all === 0 ? null : Math.round((botViews / all) * 1000) / 1000 },
    top_paths: topList(input.paths, limit).map(([path, v]) => ({ path, views: v })),
    top_referrers: topList(input.referrers, limit).map(([host, v]) => ({ host, views: v })),
  };
}
