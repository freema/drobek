import { afterEach, describe, expect, it } from 'vitest';
import { escapeHtml, renderEmailLayout } from './layout.server.js';
import { emailFromParts, fromHeader, messageFor, safeDisplayName, sendEmail } from './send.server.js';
import { getSmtpTransport, resetSmtpTransportForTests, smtpTransportOptions } from './smtp.server.js';
import { renderTextEmailHtml } from './text-email.js';

afterEach(() => resetSmtpTransportForTests());

describe('layout', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('a text e-mail shows markup as text (a <script> in a form field stays text)', () => {
    const html = renderTextEmailHtml({ subject: 'New <b>lead</b>', text: 'message: <script>alert(1)</script>\n<img src=x onerror=alert(2)>' });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('New &lt;b&gt;lead&lt;/b&gt;');
    expect(html).toContain('white-space:pre-wrap');
    expect(renderTextEmailHtml({ subject: 's', text: 't', footNote: '<i>x</i>' })).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(renderEmailLayout({ preview: 'p', body: '<p>b</p>' })).toContain('<p>b</p>');
  });

  it('the default footer carries the current tagline', () => {
    const html = renderEmailLayout({ preview: 'p', body: '<p>b</p>' });
    expect(html).toContain('a cloud workspace for agent-built web apps');
    expect(html).not.toMatch(/micro-apps|vibecoded/i);
  });
});

describe('sender', () => {
  it('EMAIL_FROM parts, bare or with a name', () => {
    expect(emailFromParts({ EMAIL_FROM: 'drobek <no-reply@drobek.app>' })).toEqual({ name: 'drobek', address: 'no-reply@drobek.app' });
    expect(emailFromParts({ EMAIL_FROM: 'no-reply@x.cz' })).toEqual({ name: '', address: 'no-reply@x.cz' });
    expect(emailFromParts({})).toEqual({ name: 'drobek', address: 'no-reply@drobek.app' });
  });

  it('a display name is one plain line (no header injection, no address look-alikes)', () => {
    expect(safeDisplayName('Acme\r\nBcc: evil@example.com')).toBe('Acme Bcc: evil example.com');
    expect(safeDisplayName('"Pay" <pal>')).toBe('Pay pal');
    expect(safeDisplayName('x'.repeat(200))).toHaveLength(80);
    expect(fromHeader('Acme shop', { EMAIL_FROM: 'drobek <no-reply@drobek.app>' })).toEqual({ name: 'Acme shop', address: 'no-reply@drobek.app' });
    expect(fromHeader('  ', { EMAIL_FROM: 'drobek <no-reply@drobek.app>' })).toEqual({ name: 'drobek', address: 'no-reply@drobek.app' });
  });

  it('without SMTP: dev reports not_configured, production throws', async () => {
    const mail = { to: 'a@b.cz', subject: 's', text: 't', html: '<p>t</p>' };
    await expect(sendEmail(mail, { NODE_ENV: 'development' })).resolves.toBe('not_configured');
    await expect(sendEmail(mail, { NODE_ENV: 'production' })).rejects.toThrow(/SMTP/);
  });
});

describe('transport (nodemailer 10)', () => {
  it('SMTP options: STARTTLS on 587 by default, implicit TLS with SMTP_SECURE=1, auth only with both creds', () => {
    expect(smtpTransportOptions({ SMTP_HOST: ' smtp.hostinger.com ', SMTP_USER: 'u@x.cz', SMTP_PASS: 'p' })).toEqual({
      host: 'smtp.hostinger.com',
      port: 587,
      secure: false,
      auth: { user: 'u@x.cz', pass: 'p' },
    });
    expect(smtpTransportOptions({ SMTP_HOST: 'smtp.hostinger.com', SMTP_PORT: '465', SMTP_SECURE: '1', SMTP_USER: 'u', SMTP_PASS: 'p' })).toMatchObject({
      port: 465,
      secure: true,
    });
    // mailpit: host alone, no auth; a user without a password sends no auth either.
    expect(smtpTransportOptions({ SMTP_HOST: 'mailpit', SMTP_PORT: '1025' })).toEqual({ host: 'mailpit', port: 1025, secure: false });
    expect(smtpTransportOptions({ SMTP_HOST: 'mailpit', SMTP_USER: 'u' })).not.toHaveProperty('auth');
  });

  it('dev without SMTP_HOST falls back to the JSON transport; production refuses', async () => {
    const t = await getSmtpTransport({ NODE_ENV: 'development' });
    const info = await t.sendMail(messageFor({ to: 'a@b.cz', subject: 's', text: 't', html: '<p>t</p>' }, {}));
    const json = JSON.parse(String((info as { message: string }).message));
    expect(json.from).toEqual({ name: 'drobek', address: 'no-reply@drobek.app' });
    expect(json.subject).toBe('s');
    resetSmtpTransportForTests();
    await expect(getSmtpTransport({ NODE_ENV: 'production' })).rejects.toThrow(/SMTP_HOST/);
  });

  it('the rendered message: sender and Reply-To are address objects, a hostile name injects no header', async () => {
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const env = { EMAIL_FROM: 'drobek <no-reply@drobek.app>' };
    const info = await t.sendMail(
      messageFor({ to: 'lead@example.com', subject: 'New lead', text: 'hi', html: '<p>hi</p>', fromName: 'Acme\r\nBcc: evil@example.com', replyTo: 'visitor@example.org' }, env)
    );
    const raw = String(info.message);
    const headers = raw.slice(0, raw.indexOf('\n\n'));
    expect(headers).toMatch(/^From: .*Acme Bcc: evil example\.com.* <no-reply@drobek\.app>$/m);
    expect(headers).toMatch(/^Reply-To: visitor@example\.org$/m);
    expect(headers).toMatch(/^To: lead@example\.com$/m);
    expect(headers).not.toMatch(/^Bcc:/im);
    expect(info.envelope).toEqual({ from: 'no-reply@drobek.app', to: ['lead@example.com'] });
  });
});
