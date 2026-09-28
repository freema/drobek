import { afterEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@drobek/core';
import { pendingMail } from './pending-mail.js';
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

  it('the pending-change mail (a platform mail): a Review button to the confirm URL, the URL in the text part, the server named by PUBLIC_APP_URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: KEY, PUBLIC_APP_URL: 'https://apps.example.org' };
    const review = 'https://apps.example.org/workspaces/freema/apps/tycoon/modules/data';
    const mail = pendingMail({
      appName: 'Drobek Tycoon',
      serverHost: 'apps.example.org',
      modules: [{ module: 'data', changes: ['data.collections.scores.rules.create: (new collection) → "public"'], confirmUrl: review }],
    });
    await smtpEmailTransport(noopLogger, env).send({
      to: 'owner@example.com',
      subject: mail.subject,
      text: mail.text,
      platform: { actions: mail.actions, closing: mail.closing, footNote: mail.footNote },
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { html: string; text: string };
    expect(body.html).toContain(`<a href="${review}"`);
    expect(body.text).toContain(`Review the data changes: ${review}`);
    expect(body.text).toContain('Nothing changes until you confirm them in the dashboard at apps.example.org.');
    expect(body.html).toContain('Sent by the drobek server at apps.example.org because you can edit this app.');
    expect(body.html).not.toContain('Sent by an app hosted on drobek');
    expect(body.text).not.toContain('drobek.app');
  });

  it('an app-authored mail with URL-looking text has no link; an off-origin platform action is refused', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_3' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: KEY, PUBLIC_APP_URL: 'https://apps.example.org' };
    const transport = smtpEmailTransport(noopLogger, env);
    await transport.send({ to: 'a@b.cz', subject: 's', text: 'Log in at https://apps.example.org/login <a href="https://evil.example">now</a>' });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { html: string };
    expect(body.html).not.toMatch(/<a[\s>]/);
    expect(body.html).toContain('Sent by an app hosted on drobek');
    await expect(
      transport.send({ to: 'a@b.cz', subject: 's', text: 't', platform: { actions: [{ label: 'Go', url: 'https://evil.example/' }], footNote: 'f' } })
    ).rejects.toThrow(/own origin/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
