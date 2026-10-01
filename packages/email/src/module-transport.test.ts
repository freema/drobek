import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installEmailTransport,
  installedEmailTransportId,
  redactSecrets,
  resetEmailTransportForTests,
  type EmailTransportContext,
  type EmailTransportMessage,
  type ModuleEmailTransport,
} from './module-transport.server.js';
import { EmailSendError } from './resend.server.js';
import { sendEmail } from './send.server.js';
import { resetSmtpTransportForTests } from './smtp.server.js';
import { emailConfigError, emailTransportKind } from './transport.server.js';

// A fake token: tests never read a real one.
const TOKEN = 'pm_test_fake_token_0123456789';
const ENV = { EMAIL_TRANSPORT: 'relay', RELAY_TOKEN: TOKEN, EMAIL_FROM: 'drobek <no-reply@drobek.app>' };
const mail = { to: 'lead@example.com', subject: 'Your code', text: 'code 123456', html: '<p>code 123456</p>' };

function relay(send: ModuleEmailTransport['send']): ModuleEmailTransport {
  return { id: 'relay', label: 'Company relay', secrets: ['RELAY_TOKEN'], send };
}

afterEach(() => {
  resetEmailTransportForTests();
  resetSmtpTransportForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('module transport selection (EMAIL_TRANSPORT=<id>)', () => {
  it('a transport id is a module transport; smtp and resend stay built in; an invalid value refuses without echoing it', () => {
    expect(emailTransportKind({ EMAIL_TRANSPORT: 'relay' })).toBe('module');
    expect(emailTransportKind({ EMAIL_TRANSPORT: ' Postmark ' })).toBe('module');
    expect(emailTransportKind({ EMAIL_TRANSPORT: 'smtp' })).toBe('smtp');
    expect(emailTransportKind({ EMAIL_TRANSPORT: 'resend' })).toBe('resend');
    expect(emailConfigError({ EMAIL_TRANSPORT: 'postmark' })).toBeNull();
    expect(emailConfigError({ EMAIL_TRANSPORT: 'postmark', NODE_ENV: 'production' })).toBeNull();
    const bad = emailConfigError({ EMAIL_TRANSPORT: 'pm_test_secret-ish' });
    expect(bad).toMatch(/EMAIL_TRANSPORT must be/);
    expect(bad).not.toContain('pm_test_secret-ish');
  });

  it('EMAIL_TRANSPORT_TIMEOUT_MS: milliseconds in range, else a start refusal', () => {
    expect(emailConfigError({ EMAIL_TRANSPORT_TIMEOUT_MS: '5000' })).toBeNull();
    expect(emailConfigError({ EMAIL_TRANSPORT_TIMEOUT_MS: '10s' })).toMatch(/EMAIL_TRANSPORT_TIMEOUT_MS/);
    expect(emailConfigError({ EMAIL_TRANSPORT_TIMEOUT_MS: '50' })).toMatch(/EMAIL_TRANSPORT_TIMEOUT_MS/);
  });

  it('installing reads the declared secrets from the env; a missing one is refused by name', () => {
    expect(() => installEmailTransport(relay(async () => {}), { EMAIL_TRANSPORT: 'relay' })).toThrow(/needs RELAY_TOKEN/);
    expect(installedEmailTransportId()).toBeNull();
    installEmailTransport(relay(async () => {}), ENV);
    expect(installedEmailTransportId()).toBe('relay');
    installEmailTransport(null);
    expect(installedEmailTransportId()).toBeNull();
  });
});

describe('sending through a module transport', () => {
  it('sendEmail hands the transport the same message as the built-ins, and its secrets', async () => {
    const calls: [EmailTransportMessage, EmailTransportContext][] = [];
    installEmailTransport(relay(async (m, ctx) => void calls.push([m, ctx])), ENV);
    await expect(sendEmail({ ...mail, fromName: 'Acme "shop" <x>', replyTo: 'visitor@example.org' }, ENV)).resolves.toBe('sent');
    expect(calls).toHaveLength(1);
    const [m, ctx] = calls[0];
    expect(m).toEqual({
      from: { name: 'Acme shop x', address: 'no-reply@drobek.app' },
      to: 'lead@example.com',
      subject: 'Your code',
      text: 'code 123456',
      html: '<p>code 123456</p>',
      replyTo: 'visitor@example.org',
    });
    expect(ctx.secrets).toEqual({ RELAY_TOKEN: TOKEN });
    expect(ctx.signal.aborted).toBe(false);
  });

  it('smtp and resend never reach an installed module transport', async () => {
    const send = vi.fn(async () => {});
    installEmailTransport(relay(send), ENV);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status: 200 })));
    await expect(sendEmail(mail, { NODE_ENV: 'development' })).resolves.toBe('not_configured');
    await expect(sendEmail(mail, { EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_fake_key_1234' })).resolves.toBe('sent');
    expect(send).not.toHaveBeenCalled();
  });

  it('EMAIL_TRANSPORT naming a transport that is not installed is unavailable, not SMTP', async () => {
    await expect(sendEmail(mail, ENV)).rejects.toMatchObject({ name: 'EmailSendError', code: 'unavailable' });
    installEmailTransport(relay(async () => {}), ENV);
    await expect(sendEmail(mail, { ...ENV, EMAIL_TRANSPORT: 'other' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('an EmailSendError keeps its code, status and Retry-After; the secret is redacted from the message', async () => {
    installEmailTransport(
      relay(async (_m, { secrets }) => {
        throw new EmailSendError('rate_limited', `429 for token ${secrets.RELAY_TOKEN}`, { status: 429, retryAfterSec: 30 });
      }),
      ENV
    );
    const err = (await sendEmail(mail, ENV).catch((e: unknown) => e)) as EmailSendError;
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err).toMatchObject({ code: 'rate_limited', status: 429, retryAfterSec: 30, retryable: true });
    expect(err.message).toBe('e-mail transport "relay": 429 for token [redacted]');
  });

  it('a plain throw becomes unavailable with the error name, the secret redacted', async () => {
    installEmailTransport(
      relay(async (_m, { secrets }) => {
        throw new TypeError(`bad auth header Bearer ${secrets.RELAY_TOKEN}`);
      }),
      ENV
    );
    const err = (await sendEmail(mail, ENV).catch((e: unknown) => e)) as EmailSendError;
    expect(err).toMatchObject({ name: 'EmailSendError', code: 'unavailable', retryable: true });
    expect(err.message).toBe('e-mail transport "relay" failed (TypeError: bad auth header Bearer [redacted])');
    expect(err.message).not.toContain(TOKEN);
  });

  it('a send past EMAIL_TRANSPORT_TIMEOUT_MS is cut off: timeout, and the signal is aborted', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null = null;
    installEmailTransport(
      relay((_m, ctx) => {
        signal = ctx.signal;
        return new Promise(() => {});
      }),
      { ...ENV, EMAIL_TRANSPORT_TIMEOUT_MS: '2000' }
    );
    const p = sendEmail(mail, ENV).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toMatchObject({ name: 'EmailSendError', code: 'timeout', message: 'e-mail transport "relay" did not answer within 2000 ms' });
    expect(signal!.aborted).toBe(true);
  });

  it('redactSecrets replaces every value, the longer first', () => {
    expect(redactSecrets('a=abc b=abcdef', { A: 'abc', B: 'abcdef' })).toBe('a=[redacted] b=[redacted]');
    expect(redactSecrets('nothing', {})).toBe('nothing');
  });
});
