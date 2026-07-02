import { createHash, createHmac, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { TEST_ENV } from '../playwright.config';

/**
 * P0-B acceptance (D2/PHY-96/PHY-100): one signed PUT + GET round-trip; a
 * tampered body (sha mismatch) is rejected with nothing persisted; the
 * token-bound byte cap and expiry/signature checks hold.
 *
 * Token minting is deliberately RE-IMPLEMENTED here (not imported from
 * @drobek/core): the token format is a wire contract, and a second
 * independent implementation catches accidental format drift.
 */

const SECRET = process.env.UPLOAD_SIGNING_SECRET ?? '';

type Payload = { sha256: string; maxBytes: number; exp: number };

function mintToken(payload: Payload, secret: string = SECRET): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function skipUnlessLocal(): void {
  test.skip(TEST_ENV !== 'local', 'requires TEST_ENV=local (local compose stack)');
  test.skip(
    !SECRET,
    'requires UPLOAD_SIGNING_SECRET (same value the stack was started with — use `task e2e`)'
  );
}

async function putBlob(
  request: APIRequestContext,
  token: string,
  body: Buffer,
  contentType = 'application/octet-stream'
) {
  return request.put(`/__upload/${token}`, {
    data: body,
    headers: { 'content-type': contentType },
  });
}

test('blob round-trip: signed PUT then GET returns identical bytes @local', async ({
  request,
}) => {
  skipUnlessLocal();

  // Random bytes → a content hash no earlier run could have persisted.
  const body = Buffer.concat([Buffer.from('drobek p0-b round-trip '), randomBytes(48)]);
  const sha = sha256Hex(body);
  const token = mintToken({ sha256: sha, maxBytes: 1024, exp: nowSec() + 300 });

  const put = await putBlob(request, token, body, 'text/plain');
  expect(put.status()).toBe(200);
  expect(await put.json()).toEqual({ ok: true, sha256: sha });

  const get = await request.get(`/__blob/${sha}`);
  expect(get.status()).toBe(200);
  expect(get.headers()['content-type']).toBe('text/plain');
  expect(get.headers()['x-content-type-options']).toBe('nosniff');
  expect(get.headers()['etag']).toBe(`"${sha}"`);
  expect(Buffer.compare(await get.body(), body)).toBe(0);
});

test('tampered body (sha mismatch) is rejected and nothing is persisted @local', async ({
  request,
}) => {
  skipUnlessLocal();

  const intended = randomBytes(64);
  const shaX = sha256Hex(intended);
  const token = mintToken({ sha256: shaX, maxBytes: 1024, exp: nowSec() + 300 });

  // PUT a DIFFERENT body under the token minted for sha X.
  const put = await putBlob(request, token, randomBytes(64));
  expect(put.status()).toBe(422);
  expect(await put.json()).toEqual({ ok: false, error: 'sha256-mismatch' });

  // Nothing persisted under X — neither file nor metadata row.
  const get = await request.get(`/__blob/${shaX}`);
  expect(get.status()).toBe(404);
});

test('body larger than the token maxBytes cap is rejected @local', async ({
  request,
}) => {
  skipUnlessLocal();

  const body = randomBytes(256);
  const sha = sha256Hex(body); // correct hash — the CAP must reject it anyway
  const token = mintToken({ sha256: sha, maxBytes: 16, exp: nowSec() + 300 });

  const put = await putBlob(request, token, body);
  expect(put.status()).toBe(413);
  expect(await put.json()).toEqual({ ok: false, error: 'max-bytes-exceeded' });

  const get = await request.get(`/__blob/${sha}`);
  expect(get.status()).toBe(404);
});

test('expired and invalid upload tokens are rejected with 401/403 @local', async ({
  request,
}) => {
  skipUnlessLocal();

  const body = randomBytes(32);
  const sha = sha256Hex(body);

  // Expired → 403.
  const expired = mintToken({ sha256: sha, maxBytes: 1024, exp: nowSec() - 60 });
  const putExpired = await putBlob(request, expired, body);
  expect(putExpired.status()).toBe(403);
  expect(await putExpired.json()).toEqual({ ok: false, error: 'token-expired' });

  // Wrong signing secret → 401.
  const forged = mintToken(
    { sha256: sha, maxBytes: 1024, exp: nowSec() + 300 },
    'not-the-real-secret'
  );
  const putForged = await putBlob(request, forged, body);
  expect(putForged.status()).toBe(401);
  expect(await putForged.json()).toEqual({
    ok: false,
    error: 'token-bad-signature',
  });

  // Garbage token → 401.
  const putGarbage = await putBlob(request, 'not-a-token', body);
  expect(putGarbage.status()).toBe(401);

  // None of the rejected uploads persisted anything.
  const get = await request.get(`/__blob/${sha}`);
  expect(get.status()).toBe(404);
});
