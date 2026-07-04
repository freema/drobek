/**
 * The public error-beacon HTTP handler (PHY-123): `POST /:ws/app/:slug/__beacon`.
 * A react-free web `Request`→`Response` core (mirrored by the saas web app with a
 * thin route), so the whole security contract lives here + in @drobek/insights:
 *
 *   1. POST only; same-origin (called by the served app's own JS),
 *   2. 8 KB HARD cap enforced BEFORE fully reading/parsing the body — the
 *      Content-Length is a cheap pre-check, the mid-stream byte counter is
 *      authoritative (a chunked over-cap body aborts → 413),
 *   3. parse the JSON batch, then hand to recordBeacon with the client IP
 *      (X-Forwarded-For aware),
 *   4. return 204 fast + no-store. Unknown app → 404, over-cap → 413,
 *      rate-limited → 429.
 */
import { getClientIp } from '@drobek/auth';
import { recordBeacon } from './beacon.server.js';
import { InsightsError, insightsErrorStatus } from './errors.js';
import { BEACON_MAX_BYTES } from './limits.js';

export interface BeaconParams {
  wsSlug: string;
  appSlug: string;
}

function beaconResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

class PayloadTooLarge extends Error {}
class RequestAborted extends Error {}

/**
 * Read the body as text with an 8 KB hard cap, DRAINING (not cancelling) an
 * over-cap body.
 *
 * SECURITY — do NOT call `reader.cancel()` on this stream. node-fetch-server
 * builds the request-body ReadableStream (request-listener.js `createRequest`)
 * with NO `cancel` handler and an unconditional
 * `req.on('end', () => controller.close())`. After a `reader.cancel()` closes
 * the controller, the underlying IncomingMessage still emits 'end' and calls
 * `controller.close()` on an already-closed controller → an UNCAUGHT
 * `ERR_INVALID_STATE` TypeError that exits the process. On a PUBLIC,
 * unauthenticated endpoint that is a one-request remote crash of the whole web
 * tier. Instead we DRAIN-and-DISCARD: keep reading to completion (memory stays
 * bounded — we stop accumulating and release the buffer once over cap) so the
 * stream closes naturally, then throw 413. We also bail if the request is
 * aborted (socket close / requestTimeout) so a stalled/endless chunked stream
 * cannot pin the drain loop.
 */
async function readCappedText(request: Request, cap: number): Promise<string> {
  const body = request.body;
  if (!body) {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > cap) {
      throw new PayloadTooLarge();
    }
    return text;
  }
  const signal = request.signal;
  const reader = body.getReader();
  let chunks: Uint8Array[] | null = [];
  let received = 0;
  let overCap = false;
  try {
    for (;;) {
      if (signal?.aborted) throw new RequestAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (overCap) continue; // still draining to let the stream close cleanly
      if (received > cap) {
        // Over cap: stop accumulating and free what we buffered (bounded
        // memory), but keep reading so the stream reaches 'end' and closes.
        overCap = true;
        chunks = null;
        continue;
      }
      chunks!.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (overCap) throw new PayloadTooLarge();
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks!) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function handleBeacon(
  request: Request,
  params: BeaconParams
): Promise<Response> {
  if (request.method !== 'POST') return beaconResponse(405);

  // 2a. Cheap pre-check on the declared length.
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > BEACON_MAX_BYTES) {
    return beaconResponse(413);
  }

  // 2b. Authoritative mid-stream cap.
  let bodyText: string;
  try {
    bodyText = await readCappedText(request, BEACON_MAX_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLarge) return beaconResponse(413);
    // Socket aborted mid-read (client gone / requestTimeout): the response is
    // moot, but return a benign status rather than throwing.
    if (err instanceof RequestAborted) return beaconResponse(400);
    return beaconResponse(400);
  }

  let batch: unknown;
  try {
    batch = bodyText.trim() === '' ? {} : JSON.parse(bodyText);
  } catch {
    return beaconResponse(400);
  }

  const ip = getClientIp(request) ?? 'unknown';

  try {
    await recordBeacon({
      wsSlug: params.wsSlug,
      appSlug: params.appSlug,
      batch,
      ip,
    });
    return beaconResponse(204);
  } catch (err) {
    if (err instanceof InsightsError) {
      return beaconResponse(insightsErrorStatus(err.code));
    }
    return beaconResponse(500);
  }
}
