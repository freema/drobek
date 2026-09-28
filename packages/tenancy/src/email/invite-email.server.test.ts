import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptInviteUrl } from '../invites.server.js';
import { renderInviteEmail, sendInviteEmail } from './invite-email.server.js';

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
    vi.stubEnv('PUBLIC_APP_URL', 'https://drobek.test');
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

  it('names the server, links Accept as a button on its origin; the invite link falls back to PUBLIC_APP_URL', () => {
    const env = { PUBLIC_APP_URL: 'https://apps.example.org' };
    const acceptUrl = acceptInviteUrl('tok', env);
    expect(acceptUrl).toBe('https://apps.example.org/invite/tok');
    const mail = renderInviteEmail({ workspaceName: 'Acme', role: 'editor', acceptUrl }, env);
    expect(mail.html).toContain(`<a href="${acceptUrl}"`);
    expect(mail.html).toContain('Sent by the drobek server at apps.example.org');
    expect(mail.text).toContain('on the drobek server at apps.example.org as editor');
    expect(mail.text).toContain(`Accept the invitation: ${acceptUrl}`);
    expect(() => renderInviteEmail({ workspaceName: 'Acme', role: 'editor', acceptUrl: 'https://evil.example/invite/t' }, env)).toThrow();
  });
});
