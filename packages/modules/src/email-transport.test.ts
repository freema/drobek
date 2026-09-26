import { afterEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@drobek/core';
import { smtpEmailTransport } from './runtime.js';

// A fake key: tests never read a real one.
const KEY = 're_test_fake_module_0123';

afterEach(() => vi.unstubAllGlobals());

describe('module e-mail over the operator transport (NSO-361)', () => {
  it('EMAIL_TRANSPORT=resend: ctx.email.send goes out through the Resend API with the display name and Reply-To', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: KEY, EMAIL_FROM: 'drobek <no-reply@drobek.app>' };
    await smtpEmailTransport(noopLogger, env).send({
      to: 'owner@example.com',
      subject: 'New lead',
      text: 'name: Ana',
      fromName: 'Acme shop',
      replyTo: 'visitor@example.org',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: '"Acme shop" <no-reply@drobek.app>',
      to: ['owner@example.com'],
      subject: 'New lead',
      text: 'name: Ana',
      reply_to: 'visitor@example.org',
    });
    expect(String(body.html)).toContain('Sent by an app hosted on drobek');
  });

  it('a Resend error rejects (the runtime turns it into its 503 "could not be sent")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    const env = { EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: KEY };
    await expect(smtpEmailTransport(noopLogger, env).send({ to: 'a@b.cz', subject: 's', text: 't' })).rejects.toMatchObject({
      name: 'EmailSendError',
      code: 'unavailable',
    });
  });
});
