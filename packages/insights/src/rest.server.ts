/**
 * The public error-beacon HTTP handler (PHY-123; on the apps origin since
 * M1-07): `POST /__drobek/v1/_beacon` on every app host. Framework-free — a
 * plain request description in, a plain response out; @drobek/serving calls it
 * for the app it resolved from the Host (after the password gate), so the app
 * is never named by the client.
 *
 *   1. POST only (405 otherwise);
 *   2. same-origin only: an `Origin` must be the app host itself (`null` and
 *      foreign origins → 403), and `Sec-Fetch-Site: cross-site|same-site` → 403
 *      — another site cannot fill an app's error log from its visitors'
 *      browsers;
 *   3. 8 KiB HARD cap: a declared Content-Length over the cap → 413 before a
 *      byte is read; otherwise the adapter's `readBody` counts the bytes and
 *      answers 'too_large' past the cap while DRAINING the rest of the body
 *      (never destroying/cancelling the request stream — see the regression
 *      test in @drobek/serving node.test.ts: 9 KiB → 413, process alive);
 *   4. parse the JSON batch → recordBeacon (rate limits, redaction, ring buffer);
 *   5. 204 fast + no-store. Over-cap → 413, rate-limited → 429, bad JSON → 400.
 */
import { recordBeacon, type RecordBeaconInput, type RecordBeaconResult } from './beacon.server.js';
import { InsightsError, insightsErrorStatus } from './errors.js';
import { BEACON_MAX_BYTES } from './limits.js';

/** Where the beacon answers on every app host (core, not a module). */
export const BEACON_PATH = '/__drobek/v1/_beacon';

export interface BeaconRequest {
  method: string;
  header(name: string): string | null;
  /**
   * The raw body up to `limit` bytes; 'too_large' past it (the adapter keeps
   * draining the rest of the body); null when the stream failed.
   */
  readBody(limit: number): Promise<Buffer | 'too_large' | null>;
  clientIp: string | null;
}

export interface BeaconResponse {
  status: number;
  headers: Record<string, string>;
  body: null;
}

export type BeaconRecorder = (input: RecordBeaconInput) => Promise<RecordBeaconResult>;

export interface BeaconOptions {
  /** Storage seam (tests); default recordBeacon. */
  record?: BeaconRecorder;
}

function beaconResponse(status: number, extra: Record<string, string> = {}): BeaconResponse {
  return {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
    body: null,
  };
}

/** Is this POST from the app's own pages? (absent Origin = a non-browser client). */
export function beaconSameOrigin(origin: string | null, host: string | null, fetchSite: string | null): boolean {
  const site = fetchSite?.trim().toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return false;
  const o = origin?.trim();
  if (!o) return true;
  if (o === 'null' || !host) return false;
  try {
    return new URL(o).host.toLowerCase() === host.trim().toLowerCase().replace(/\.(?=:|$)/, '');
  } catch {
    return false;
  }
}

/** Answer one beacon POST for the app `appId` (never throws). */
export async function handleBeacon(
  req: BeaconRequest,
  appId: string,
  opts: BeaconOptions = {}
): Promise<BeaconResponse> {
  if (req.method.toUpperCase() !== 'POST') return beaconResponse(405, { Allow: 'POST' });
  if (!beaconSameOrigin(req.header('origin'), req.header('host'), req.header('sec-fetch-site'))) {
    return beaconResponse(403);
  }

  const declared = Number(req.header('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > BEACON_MAX_BYTES) return beaconResponse(413);

  let body: Buffer | 'too_large' | null;
  try {
    body = await req.readBody(BEACON_MAX_BYTES);
  } catch {
    body = null;
  }
  if (body === 'too_large') return beaconResponse(413);
  if (body === null) return beaconResponse(400);

  let batch: unknown;
  try {
    const text = body.toString('utf8');
    batch = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return beaconResponse(400);
  }

  try {
    await (opts.record ?? recordBeacon)({ appId, batch, ip: req.clientIp });
    return beaconResponse(204);
  } catch (err) {
    if (err instanceof InsightsError) return beaconResponse(insightsErrorStatus(err.code));
    return beaconResponse(500);
  }
}
