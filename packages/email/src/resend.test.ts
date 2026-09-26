import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailSendError, RESEND_API_URL, resendPayload, sendViaResend } from './resend.server.js';
import { sendEmail } from './send.server.js';
import { resetSmtpTransportForTests } from './smtp.server.js';
import { emailConfigError, emailTransportKind } from './transport.server.js';

// A fake key: tests never read a real one.
const KEY = 're_test_fake_0123456789';
const RESEND_ENV = { EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: KEY, EMAIL_FROM: 'drobek <no-reply@drobek.app>' };
const mail = { to: 'lead@example.com', subject: 'Your code', text: 'code 123456', html: '<p>code 123456</p>' };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSmtpTransportForTests();
});

describe('transport selection (EMAIL_TRANSPORT)', () => {
  it('smtp is the default; resend when asked; case and spaces do not matter', () => {
    expect(emailTransportKind({})).toBe('smtp');
    expect(emailTransportKind({ EMAIL_TRANSPORT: '' })).toBe('smtp');
    expect(emailTransportKind({ EMAIL_TRANSPORT: 'smtp' })).toBe('smtp');
    expect(emailTransportKind({ EMAIL_TRANSPORT: ' Resend ' })).toBe('resend');
  });

  it('start-up check: resend without RESEND_API_KEY and unknown values refuse; the message names variables, never a value', () => {
    expect(emailConfigError({})).toBeNull();
    expect(emailConfigError({ EMAIL_TRANSPORT: 'smtp' })).toBeNull();
    expect(emailConfigError(RESEND_ENV)).toBeNull();
    expect(emailConfigError({ EMAIL_TRANSPORT: 'resend' })).toMatch(/RESEND_API_KEY/);
    expect(emailConfigError({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: '   ' })).toMatch(/RESEND_API_KEY/);
    const unknown = emailConfigError({ EMAIL_TRANSPORT: 'sendgrid-secret-ish', RESEND_API_KEY: KEY });
    expect(unknown).toMatch(/EMAIL_TRANSPORT must be/);
    expect(unknown).not.toContain('sendgrid-secret-ish');
    expect(unknown).not.toContain(KEY);
    // Production needs a working transport: smtp without SMTP_HOST refuses, resend does not need it.
    expect(emailConfigError({ NODE_ENV: 'production' })).toMatch(/SMTP_HOST/);
    expect(emailConfigError({ NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com' })).toBeNull();
    expect(emailConfigError({ NODE_ENV: 'production', EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: KEY })).toBeNull();
    expect(emailConfigError({ NODE_ENV: 'development' })).toBeNull();
  });

  it('the default (smtp) never calls fetch: dev without SMTP_HOST is still not_configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendEmail(mail, { NODE_ENV: 'development', RESEND_API_KEY: KEY })).resolves.toBe('not_configured');
    await expect(sendEmail(mail, { NODE_ENV: 'production' })).rejects.toThrow(/SMTP/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Resend transport (fetch, no SDK)', () => {
  it('sendEmail posts one JSON message to the Resend API with the Bearer key', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'msg_1' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendEmail({ ...mail, fromName: 'Acme "shop" <x>', replyTo: 'visitor@example.org' }, RESEND_ENV)).resolves.toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_API_URL);
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      from: '"Acme shop x" <no-reply@drobek.app>',
      to: ['lead@example.com'],
      subject: 'Your code',
      html: '<p>code 123456</p>',
      text: 'code 123456',
      reply_to: 'visitor@example.org',
    });
    // The key goes into the header only.
    expect(String(init.body)).not.toContain(KEY);
  });

  it('the sender: EMAIL_FROM with its name, a bare address, no Reply-To field without one', () => {
    expect(resendPayload(mail, { name: 'drobek', address: 'no-reply@drobek.app' })).toMatchObject({ from: '"drobek" <no-reply@drobek.app>' });
    const bare = resendPayload(mail, { name: '', address: 'no-reply@x.cz' });
    expect(bare.from).toBe('no-reply@x.cz');
    expect(bare).not.toHaveProperty('reply_to');
  });

  it('HTTP errors map onto EmailSendError: 429 rate_limited (+Retry-After), 401/403 unauthorized, 4xx rejected, 5xx unavailable', async () => {
    const cases: Array<[number, unknown, Record<string, string>, Partial<EmailSendError>]> = [
      [429, { name: 'rate_limit_exceeded', message: 'Too many requests' }, { 'retry-after': '2' }, { code: 'rate_limited', status: 429, retryAfterSec: 2, retryable: true }],
      [401, { name: 'missing_api_key', message: 'Missing API key' }, {}, { code: 'unauthorized', status: 401, retryable: false }],
      [403, { name: 'invalid_api_key', message: `API key ${KEY} is invalid` }, {}, { code: 'unauthorized', status: 403, retryable: false }],
      [422, { name: 'validation_error', message: 'Invalid `to` field: lead@example.com' }, {}, { code: 'rejected', status: 422, retryable: false }],
      [400, 'not json', {}, { code: 'rejected', status: 400 }],
      [500, { name: 'internal_server_error', message: 'boom' }, {}, { code: 'unavailable', status: 500, retryable: true }],
      [503, {}, {}, { code: 'unavailable', status: 503, retryable: true }],
    ];
    for (const [status, body, headers, expected] of cases) {
      const fetchMock = vi.fn(async () => jsonResponse(status, body, headers));
      const err = await sendViaResend(mail, { name: '', address: 'no-reply@drobek.app' }, RESEND_ENV, { fetch: fetchMock as unknown as typeof fetch }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmailSendError);
      expect(err).toMatchObject(expected);
      const message = (err as Error).message;
      expect(message).toContain(`HTTP ${status}`);
      // Neither the key nor Resend's free text (which may quote the recipient or the key) is echoed.
      expect(message).not.toContain(KEY);
      expect(message).not.toContain('lead@example.com');
      expect(message).not.toMatch(/Too many requests|Invalid `to`|boom/);
    }
  });

  it('a 429 through sendEmail rejects (the callers answer their existing "could not be sent")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(429, { name: 'rate_limit_exceeded' })));
    await expect(sendEmail(mail, RESEND_ENV)).rejects.toMatchObject({ name: 'EmailSendError', code: 'rate_limited' });
  });

  it('a hanging request is aborted after the timeout; a network error is unavailable', async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const err = await sendViaResend(mail, { name: '', address: 'a@b.cz' }, RESEND_ENV, { fetch: hang as unknown as typeof fetch, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'EmailSendError', code: 'timeout', retryable: true });
    expect((err as Error).message).toMatch(/20 ms/);

    const down = vi.fn(async () => {
      throw new TypeError(`fetch failed: Bearer ${KEY}`);
    });
    const netErr = await sendViaResend(mail, { name: '', address: 'a@b.cz' }, RESEND_ENV, { fetch: down as unknown as typeof fetch }).catch((e: unknown) => e);
    expect(netErr).toMatchObject({ code: 'unavailable' });
    expect((netErr as Error).message).not.toContain(KEY);
  });

  it('resend without a key never calls fetch, in dev too (no silent fallback)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendEmail(mail, { EMAIL_TRANSPORT: 'resend', NODE_ENV: 'development' })).rejects.toThrow(/RESEND_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
