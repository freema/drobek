import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSmtpTransportForTests } from '@drobek/email';
import { sendLoginCodeEmail } from './send-login-code.server.js';

// A fake key: tests never read a real one.
const KEY = 're_test_fake_login_0123';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetSmtpTransportForTests();
});

describe('sendLoginCodeEmail — the operator transport (NSO-361)', () => {
  it('EMAIL_TRANSPORT=resend: the sign-in code goes out through the Resend API', async () => {
    vi.stubEnv('EMAIL_TRANSPORT', 'resend');
    vi.stubEnv('RESEND_API_KEY', KEY);
    vi.stubEnv('EMAIL_FROM', 'drobek <no-reply@drobek.app>');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const infos = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await sendLoginCodeEmail({ email: 'ana@example.com', code: 'ABC123' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body)) as { from: string; to: string[]; html: string; text: string };
    expect(body.to).toEqual(['ana@example.com']);
    expect(body.from).toBe('"drobek" <no-reply@drobek.app>');
    expect(body.text).toContain('ABC123');
    expect(body.html).toContain('ABC123');
    // The key never reaches a log line.
    const logged = JSON.stringify([...logs.mock.calls, ...infos.mock.calls]);
    expect(logged).toContain('login code sent');
    expect(logged).not.toContain(KEY);
  });

  it('a Resend failure propagates (the sign-in route answers its existing error)', async () => {
    vi.stubEnv('EMAIL_TRANSPORT', 'resend');
    vi.stubEnv('RESEND_API_KEY', KEY);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"name":"rate_limit_exceeded"}', { status: 429 })));
    const err = await sendLoginCodeEmail({ email: 'ana@example.com', code: 'ABC123' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'EmailSendError', code: 'rate_limited' });
    expect((err as Error).message).not.toContain(KEY);
  });

  it('the default smtp transport without SMTP_HOST in dev: nothing sent, no fetch', async () => {
    vi.stubEnv('EMAIL_TRANSPORT', '');
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('NODE_ENV', 'development');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await expect(sendLoginCodeEmail({ email: 'ana@example.com', code: 'ABC123' })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
