/**
 * Regression tests for the beacon HTTP size-cap (PHY-123, round-2 fix).
 *
 * The headline round-1 bug: `readCappedText` called `reader.cancel()` on the
 * node-fetch-server request-body ReadableStream. That stream has NO cancel
 * handler and unconditionally does `req.on('end', () => controller.close())`,
 * so after a cancel() the IncomingMessage still emits 'end' → `controller.close()`
 * on an already-closed controller → an UNCAUGHT TypeError that exits the whole
 * web process. A single unauthenticated over-cap chunked POST took the tier down.
 *
 * The fix DRAINS the over-cap body to completion instead of cancelling. These
 * tests lock in the invariant that the request-body stream is NEVER cancelled,
 * and that over-cap bodies still get a 413.
 */
import { describe, expect, it } from 'vitest';
import { BEACON_MAX_BYTES } from './limits.js';
import { handleBeacon } from './rest.server.js';

/**
 * Build a POST Request whose body is a chunked ReadableStream with NO
 * Content-Length (mirrors `Transfer-Encoding: chunked`, which bypasses the
 * cheap declared-length pre-check and enters the streaming branch). `onCancel`
 * fires if the handler cancels the body — the exact crash primitive we forbid.
 */
function chunkedBeaconRequest(
  body: Uint8Array,
  onCancel: () => void
): Request {
  const CHUNK = 1024;
  let pos = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= body.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(pos + CHUNK, body.byteLength);
      controller.enqueue(body.subarray(pos, end));
      pos = end;
    },
    cancel() {
      onCancel();
    },
  });
  return new Request('http://localhost/ws/app/slug/__beacon', {
    method: 'POST',
    body: stream,
    // @ts-expect-error duplex is required by Node/undici for a stream body
    duplex: 'half',
  });
}

describe('handleBeacon size cap', () => {
  it('rejects an over-cap chunked body with 413 and NEVER cancels the stream', async () => {
    let cancelled = false;
    // 'x' (0x78) repeated, comfortably over the 8 KB cap.
    const big = new Uint8Array(BEACON_MAX_BYTES + 4096).fill(0x78);
    const req = chunkedBeaconRequest(big, () => {
      cancelled = true;
    });

    const res = await handleBeacon(req, { wsSlug: 'ws', appSlug: 'slug' });

    expect(res.status).toBe(413);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    // The crash primitive: cancelling this stream re-closes an already-closed
    // controller in node-fetch-server → process exit. Must NOT happen.
    expect(cancelled).toBe(false);
  });

  it('rejects an over-cap body declared via Content-Length with 413 (cheap pre-check)', async () => {
    const req = new Request('http://localhost/ws/app/slug/__beacon', {
      method: 'POST',
      headers: { 'content-length': String(BEACON_MAX_BYTES + 1) },
      body: 'x'.repeat(BEACON_MAX_BYTES + 1),
    });
    const res = await handleBeacon(req, { wsSlug: 'ws', appSlug: 'slug' });
    expect(res.status).toBe(413);
  });

  it('rejects a non-POST method with 405', async () => {
    const req = new Request('http://localhost/ws/app/slug/__beacon', {
      method: 'GET',
    });
    const res = await handleBeacon(req, { wsSlug: 'ws', appSlug: 'slug' });
    expect(res.status).toBe(405);
  });
});
