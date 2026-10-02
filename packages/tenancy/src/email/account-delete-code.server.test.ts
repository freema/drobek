import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAccountDeleteCodeEmail, sendAccountDeleteCodeEmail } from './account-delete-code.server.js';

const KEY = 're_test_fake_account_delete_0123';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the account deletion code e-mail', () => {
  it('carries the code in the subject, the text and the HTML, and names the server', () => {
    const mail = renderAccountDeleteCodeEmail({ code: ' 123456 ' }, { PUBLIC_APP_URL: 'https://apps.example.org' });
    expect(mail.subject).toBe('drobek — your code to delete your account: 123456');
    expect(mail.text).toContain('Your code to delete your drobek account: 123456');
    expect(mail.text).toContain('Delete account page at apps.example.org');
    expect(mail.text).toContain('Nothing is deleted without the code');
    expect(mail.html).toContain('>123456</p>');
    expect(mail.html).toContain('apps.example.org');
  });

  it('EMAIL_TRANSPORT=resend: the code goes out through the Resend API to the account address only', async () => {
    vi.stubEnv('EMAIL_TRANSPORT', 'resend');
    vi.stubEnv('RESEND_API_KEY', KEY);
    vi.stubEnv('PUBLIC_APP_URL', 'https://drobek.test');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await sendAccountDeleteCodeEmail({ email: 'owner@example.com', code: '654321' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { to: string[]; subject: string; text: string };
    expect(body.to).toEqual(['owner@example.com']);
    expect(body.subject).toContain('654321');
  });
});
