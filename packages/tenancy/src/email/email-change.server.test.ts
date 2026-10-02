import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderEmailChangeCodeEmail,
  renderEmailChangedEmail,
  renderEmailInUseEmail,
  sendEmailChangeCodeEmail,
  sendEmailChangedEmail,
} from './email-change.server.js';

const KEY = 're_test_fake_email_change_0123';
const ENV = { PUBLIC_APP_URL: 'https://apps.example.org' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the sign-in e-mail change e-mails', () => {
  it('the code e-mail carries the code in the subject, the text and the HTML, and names the server', () => {
    const mail = renderEmailChangeCodeEmail({ code: ' 123456 ' }, ENV);
    expect(mail.subject).toBe('drobek — your code to confirm your new sign-in e-mail: 123456');
    expect(mail.text).toContain('Your code to confirm your new drobek sign-in e-mail: 123456');
    expect(mail.text).toContain('Account page at apps.example.org');
    expect(mail.text).toContain('nothing changes without the code');
    expect(mail.html).toContain('>123456</p>');
  });

  it('the "already has an account" e-mail carries no code and says nothing changed', () => {
    const mail = renderEmailInUseEmail(ENV);
    expect(mail.subject).toBe('drobek — this address already has an account');
    expect(mail.text).toContain('already signs in to a drobek account, so nothing changed and no code was sent');
    expect(`${mail.subject}\n${mail.text}`).not.toMatch(/\b\d{6}\b/);
    expect(mail.html).toContain('apps.example.org');
  });

  it('the notice to the previous address names the masked new address and whom to write to', () => {
    const mail = renderEmailChangedEmail({ maskedNewEmail: 'ne***@example.com', contact: 'ops@example.org' }, ENV);
    expect(mail.subject).toBe('drobek — your sign-in e-mail was changed');
    expect(mail.text).toContain('now signs in with ne***@example.com');
    expect(mail.text).toContain('API keys and agent connections keep working');
    expect(mail.text).toContain('signing in with it starts a new, empty account');
    expect(mail.text).toContain('Write to the operator of this server at ops@example.org.');
    expect(renderEmailChangedEmail({ maskedNewEmail: 'ne***@example.com', contact: null }, ENV).text).toContain(
      'Contact the operator of apps.example.org.'
    );
  });

  it('EMAIL_TRANSPORT=resend: the code goes to the new address, the notice to the previous one with the new address masked', async () => {
    vi.stubEnv('EMAIL_TRANSPORT', 'resend');
    vi.stubEnv('RESEND_API_KEY', KEY);
    vi.stubEnv('PUBLIC_APP_URL', 'https://drobek.test');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await sendEmailChangeCodeEmail({ email: 'new@example.com', code: '654321' });
    await sendEmailChangedEmail({ email: 'old@example.com', newEmail: 'new@example.com', contact: null });
    const bodies = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)) as { to: string[]; subject: string; text: string }
    );
    expect(bodies.map((b) => b.to)).toEqual([['new@example.com'], ['old@example.com']]);
    expect(bodies[0]!.subject).toContain('654321');
    expect(bodies[1]!.text).toContain('ne***@example.com');
    expect(bodies[1]!.text).not.toContain('new@example.com');
  });
});
