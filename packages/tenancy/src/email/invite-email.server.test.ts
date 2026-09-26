import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendInviteEmail } from './invite-email.server.js';

// A fake key: tests never read a real one.
const KEY = 're_test_fake_invite_0123';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('sendInviteEmail — the operator transport (NSO-361)', () => {
  it('EMAIL_TRANSPORT=resend: the workspace invite goes out through the Resend API', async () => {
    vi.stubEnv('EMAIL_TRANSPORT', 'resend');
    vi.stubEnv('RESEND_API_KEY', KEY);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await sendInviteEmail({ email: 'new@example.com', workspaceName: 'Acme', role: 'editor', acceptUrl: 'https://drobek.test/invite/t' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(String(init.body)) as { to: string[]; text: string };
    expect(body.to).toEqual(['new@example.com']);
    expect(body.text).toContain('https://drobek.test/invite/t');
  });
});
