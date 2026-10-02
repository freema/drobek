import type { IncomingHttpHeaders } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { expect, test } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { skipUnlessLocal } from './helpers/auth';

/**
 * The request body cap of the dashboard origin (DASHBOARD_MAX_BODY_BYTES,
 * 1 MiB by default) in front of the dashboard, sign-in and OAuth routes.
 * Behind Caddy (`task e2e:image`) the generated Caddyfile's `request_body`
 * may answer the same 413 before drobek does.
 *
 *  - /login and /oauth/token with a 2 MiB body → 413, declared or chunked (a
 *    chunked upload may also be cut with a reset once the answer went out);
 *  - the process keeps answering: /health, the sign-in page, and a small
 *    chunked token request reaches the OAuth endpoint with its body intact
 *    (its grant_type is read);
 *  - the Data tab's collection page keeps its own, larger limit (the CSV
 *    import): an anonymous 2 MiB POST is not refused for its size — the
 *    sign-in gate answers.
 */

const ORIGIN = new URL(BASE_URL_WEB).origin;
const FORM = 'application/x-www-form-urlencoded';
const MiB = 1024 * 1024;

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * A POST to the dashboard origin; settles with the answer as soon as it
 * arrives, while the upload may still be running. A reset before any answer
 * is `status: -1`.
 */
function post(path: string, body: Buffer, opts: { chunked?: boolean; type?: string } = {}): Promise<Answer> {
  const url = new URL(path, BASE_URL_WEB);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers: Record<string, string> = { Origin: ORIGIN, 'Content-Type': opts.type ?? FORM };
  if (opts.chunked) headers['Transfer-Encoding'] = 'chunked';
  else headers['Content-Length'] = String(body.length);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (a: Answer) => {
      if (settled) return;
      settled = true;
      resolve(a);
    };
    const req = send(url, { method: 'POST', headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        settle({ status: res.statusCode ?? 0, headers: res.headers, body: text });
        req.destroy();
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout: POST ${path}`)));
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') settle({ status: -1, headers: {}, body: '' });
      else if (!settled) reject(err);
    });
    if (opts.chunked) {
      for (let i = 0; i < body.length; i += 64 * 1024) req.write(body.subarray(i, i + 64 * 1024));
      req.end();
    } else {
      req.end(body);
    }
  });
}

/** drobek's own 413 is JSON naming the limit; Caddy's carries no body. */
function expectCapAnswer(a: Answer): void {
  if (String(a.headers['content-type']).startsWith('application/json')) {
    expect(JSON.parse(a.body)).toMatchObject({ error: 'payload_too_large', details: { limit: 'DASHBOARD_MAX_BODY_BYTES' } });
  }
}

const big = Buffer.from(new URLSearchParams({ email: 'body-limit@example.com', pad: 'x'.repeat(2 * MiB) }).toString());

test('a 2 MiB body on /login and /oauth/token answers 413 (declared or chunked); the process keeps answering @local', async ({ request }) => {
  skipUnlessLocal();
  for (const path of ['/login', '/oauth/token']) {
    const declared = await post(path, big);
    expect(declared.status, `${path} declared`).toBe(413);
    expectCapAnswer(declared);
    const chunked = await post(path, big, { chunked: true });
    expect([413, -1], `${path} chunked`).toContain(chunked.status);
    if (chunked.status === 413) expectCapAnswer(chunked);
  }

  expect((await request.get('/health')).status()).toBe(200);
  expect((await request.get('/login')).status()).toBe(200);
  const small = await post('/oauth/token', Buffer.from('grant_type=authorization_code&code=not-a-code'), { chunked: true });
  expect(small.status).toBe(400);
  expect(JSON.parse(small.body)).toMatchObject({ error: 'invalid_request', error_description: 'code, redirect_uri, and code_verifier are required' });
});

test("the Data tab's collection page keeps its own body limit: an anonymous 2 MiB POST meets the sign-in gate, not the cap @local", async () => {
  skipUnlessLocal();
  const r = await post('/workspaces/body-limit-e2e/apps/none/data/todos', big, { type: 'multipart/form-data; boundary=x' });
  expect(r.status).toBe(302);
  expect(r.headers.location).toBe('/login');
});
