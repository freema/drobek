import { afterEach, describe, expect, it } from 'vitest';
import { escapeHtml, renderEmailLayout } from './layout.server.js';
import { emailFromParts, fromHeader, safeDisplayName, sendEmail } from './send.server.js';
import { resetSmtpTransportForTests } from './smtp.server.js';
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
