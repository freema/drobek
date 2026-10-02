import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { Redis } from 'ioredis';
import { hostRequest, previewHost, urlOf } from './helpers/apps-host';
import { MAILPIT_URL, mailpitMessagesFor, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import { REPORT_FIELDS, drobekEnv, opsReports, type OpsReport } from './helpers/ops-probe';

/**
 * E-mail through a module's transport (EMAIL_TRANSPORT=<id>): the dev stack
 * sends all of its mail through the `relay` transport of the operator-only
 * fixture `opsprobe`, which hands each message to Mailpit's HTTP send API
 * with the header `X-Ops-Probe-Transport: relay`. The image flow's first
 * phase keeps the built-in SMTP (this spec skips there); its second phase
 * restarts drobek with EMAIL_TRANSPORT=relay (scripts/e2e-image.sh).
 *  - a dashboard sign-in code and a module's mail (a form notification,
 *    under the app's sender name) arrive through it;
 *  - a refused send (the fixture refuses `@fail.example`, naming the address
 *    and its relay URL in the error) answers the sign-in form with 502, sends
 *    nothing, and reaches the error reporter as one `e-mail could not be
 *    sent` event: the address and the transport's secret redacted, nothing
 *    of the request — its query, headers, cookies or body;
 *  - retries of a refused send are each tried again (502, never a silent
 *    "code sent"): a failed send costs the address's hourly share and the
 *    server's brake nothing.
 */

const TRANSPORT_HEADER = 'X-Ops-Probe-Transport';

interface MailDetail {
  ID: string;
  Subject: string;
  From: { Name: string; Address: string };
}

function letters(n: number): string {
  return Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join('');
}

/** A dashboard OTP counter (`drobek:rl:<bucket>:<key>`) of the dev stack's Redis, or null when absent. */
async function otpCounter(bucket: string, key: string): Promise<string | null> {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6391', { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  try {
    return await redis.get(`drobek:rl:${bucket}:${key}`);
  } finally {
    redis.disconnect();
  }
}

function skipUnlessRelay(): void {
  skipUnlessLocal();
  test.skip(drobekEnv('EMAIL_TRANSPORT') !== 'relay', 'this stack does not send through the ops-probe relay (EMAIL_TRANSPORT=relay)');
}

async function pollMail(request: APIRequestContext, email: string, subject: string): Promise<MailDetail> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = (await mailpitMessagesFor(request, email.toLowerCase())).find((m) => (m.Subject ?? '').includes(subject))?.ID;
        return id !== undefined;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  return (await (await request.get(`${MAILPIT_URL}/api/v1/message/${id}`)).json()) as MailDetail;
}

async function headersOf(request: APIRequestContext, id: string): Promise<Record<string, string[]>> {
  const res = await request.get(`${MAILPIT_URL}/api/v1/message/${id}/headers`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as Record<string, string[]>;
}

test('a dashboard sign-in code and a form notification go out through the module transport @local', async ({ page, request }) => {
  skipUnlessRelay();
  const mcp = await mcpClient(page, request, { tag: 'mail-relay' });
  try {
    const code = await pollMail(request, mcp.email, 'sign-in code');
    expect(code.From.Address).toMatch(/@/);
    expect((await headersOf(request, code.ID))[TRANSPORT_HEADER]).toEqual(['relay']);

    const created = await callTool(mcp.client, 'create_app', { name: 'Relay Bakery E2E', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const fromName = await callTool(mcp.client, 'configure_module', { app_id: created.json.app_id, module: 'email', config: { fromName: 'Relay Bakery' } });
    expect(fromName.json, fromName.text).toMatchObject({ applied: true });
    const host = previewHost(created.json.slug as string);
    const token = await hostRequest(host, '/__drobek/v1/forms/contact/token');
    expect(token.status, token.body).toBe(200);
    await new Promise((r) => setTimeout(r, 2_100));
    const visitor = uniqueEmail('relay-visitor');
    const sent = await hostRequest(host, '/__drobek/v1/forms/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: urlOf(host), 'X-Drobek-SDK': '1' },
      body: JSON.stringify({ _t: (JSON.parse(token.body) as { token: string }).token, email: visitor, message: 'Two loaves, please' }),
    });
    expect(sent.status, sent.body).toBe(200);
    expect(JSON.parse(sent.body)).toMatchObject({ ok: true, notified: true });

    const note = await pollMail(request, mcp.email, 'New "contact" submission — Relay Bakery E2E');
    expect(note.From).toEqual({ Name: 'Relay Bakery', Address: code.From.Address });
    expect((await headersOf(request, note.ID))[TRANSPORT_HEADER]).toEqual(['relay']);
  } finally {
    await mcp.client.close();
  }
});

test('a send the transport refuses: 502 on the sign-in form, no mail, one redacted report without request data @local', async ({ request }) => {
  skipUnlessRelay();
  const marker = letters(12);
  const address = `who-${marker}@fail.example`;
  const leaks = {
    query: `q${letters(12)}`,
    header: `h${letters(12)}`,
    cookie: `c${letters(12)}`,
    body: `b${letters(12)}`,
  };
  const before = opsReports().length;

  const res = await request.post(`/login?probe=${leaks.query}`, {
    form: { email: address, note: leaks.body },
    headers: { 'X-Probe': leaks.header, Cookie: `probe_session=${leaks.cookie}` },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(502);
  expect(await res.text()).toContain('We could not send the email. Please try again in a moment.');

  let report: OpsReport | undefined;
  await expect
    .poll(
      () => {
        report = opsReports()
          .slice(before)
          .find((r) => r.event.context.kind === 'email');
        return report !== undefined;
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  const event = report!.event;
  expect(Object.keys(event).every((k) => REPORT_FIELDS.includes(k)), JSON.stringify(Object.keys(event))).toBe(true);
  expect(event).toMatchObject({ level: 'error', message: 'e-mail could not be sent' });
  expect(event.context).toEqual({ kind: 'email' });
  expect(event.error?.name).toBe('EmailSendError');
  expect(event.error?.message).toMatch(/^e-mail transport "relay": the relay at \[redacted\] refused \[email\] \(attempt [a-z]{8}\)$/);

  const sent = JSON.stringify(event);
  for (const leaked of [address, marker, 'mailpit:8025', ...Object.values(leaks)]) expect(sent).not.toContain(leaked);
  expect(await mailpitMessagesFor(request, address)).toEqual([]);
});

test('retries of a refused send are each tried again and cost the address nothing: 502 every time, no hourly share or brake used @local', async ({ request }) => {
  skipUnlessRelay();
  const address = `retry-${letters(12)}@fail.example`;
  const brakeBefore = await otpCounter('otp-global-1h', 'all');

  for (let i = 0; i < 3; i += 1) {
    const res = await request.post('/login', { form: { email: address }, maxRedirects: 0 });
    expect(res.status(), `attempt ${i + 1}`).toBe(502);
    expect(await res.text()).toContain('We could not send the email. Please try again in a moment.');
  }

  expect(await otpCounter('otp-email-1h', createHash('sha256').update(address).digest('hex'))).toBeNull();
  // The brake did not grow (its hourly window may have ended meanwhile).
  expect(Number((await otpCounter('otp-global-1h', 'all')) ?? 0)).toBeLessThanOrEqual(Number(brakeBefore ?? 0));
  expect(await mailpitMessagesFor(request, address)).toEqual([]);
});
