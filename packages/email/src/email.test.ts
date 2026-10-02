import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { escapeHtml, renderEmailLayout } from './layout.server.js';
import { emailFromParts, fromHeader, messageFor, safeDisplayName, sendEmail } from './send.server.js';
import { getSmtpTransport, resetSmtpTransportForTests, smtpTransportOptions } from './smtp.server.js';
import { renderTextEmailHtml } from './text-email.js';
import { renderPlatformEmail, serverFootNote, serverHost, trustedActionUrl } from './platform-email.js';
import { emailConfigError } from './transport.server.js';

afterEach(() => resetSmtpTransportForTests());

const DEFAULT_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 };
const MAIL = { to: 'a@b.cz', subject: 's', text: 't', html: '<p>t</p>' };

/** A local SMTP server that hangs: it never greets, or greets and then never answers. */
async function silentSmtpServer(greet: boolean): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    if (greet) socket.write('220 hung.example ESMTP\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

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

describe('platform e-mail (trusted actions)', () => {
  const env = { PUBLIC_APP_URL: 'https://apps.example.org' };
  const review = 'https://apps.example.org/workspaces/acme/apps/shop/modules/data';

  it('an action is a button (<a href>) in the HTML and a "label: url" line in the text part', () => {
    const mail = renderPlatformEmail(
      { subject: 'S', text: 'A change waits.\n', actions: [{ label: 'Review the data changes', url: review }], closing: 'Bye.' },
      env
    );
    expect(mail.html).toContain(`<a href="${review}"`);
    expect(mail.html).toContain('>Review the data changes</a>');
    expect(mail.html).toContain('Sent by the drobek server at apps.example.org.');
    expect(mail.text).toBe(`A change waits.\n\nReview the data changes: ${review}\n\nBye.`);
  });

  it('the text stays text: a URL or markup in it never becomes a link, the label is escaped', () => {
    const mail = renderPlatformEmail(
      { subject: 'S', text: 'visit https://evil.example/x <a href="https://evil.example">y</a>', actions: [{ label: '<b>Go</b>', url: review }] },
      env
    );
    expect(mail.html.match(/<a /g)).toHaveLength(1);
    expect(mail.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
    expect(mail.html).toContain('&lt;b&gt;Go&lt;/b&gt;');
  });

  it('an app-authored mail with URL-looking text has no <a> at all', () => {
    const html = renderTextEmailHtml({ subject: 'x', text: 'Click https://drobek.app/login or <a href="https://x">here</a>' });
    expect(html).not.toMatch(/<a[\s>]/);
  });

  it('refuses an action off the server origin, a non-http scheme or credentials', () => {
    for (const bad of [
      'https://evil.example/workspaces',
      'https://apps.example.org.evil.example/',
      'http://apps.example.org/x',
      'javascript:alert(1)',
      'https://user:pw@apps.example.org/',
      '/workspaces/acme',
    ]) {
      expect(() => trustedActionUrl(bad, env), bad).toThrow(/action/);
      expect(() => renderPlatformEmail({ subject: 's', text: 't', actions: [{ label: 'x', url: bad }] }, env), bad).toThrow();
    }
    expect(trustedActionUrl('https://invites.example.org/invite/t', { ...env, PUBLIC_ORIGIN: 'https://invites.example.org' })).toBe(
      'https://invites.example.org/invite/t'
    );
  });

  it('the host shown comes from PUBLIC_APP_URL (then PUBLIC_ORIGIN, then the dev default)', () => {
    expect(serverHost(env)).toBe('apps.example.org');
    expect(serverHost({ PUBLIC_ORIGIN: 'https://o.example.org/' })).toBe('o.example.org');
    expect(serverHost({})).toBe('localhost:3041');
    expect(serverFootNote('you can edit this app', { PUBLIC_APP_URL: 'https://drobek.example.com' })).toBe(
      'Sent by the drobek server at drobek.example.com because you can edit this app.'
    );
  });
});

describe('sender', () => {
  it('EMAIL_FROM parts, bare or with a name', () => {
    expect(emailFromParts({ EMAIL_FROM: 'drobek <no-reply@drobek.app>' })).toEqual({ name: 'drobek', address: 'no-reply@drobek.app' });
    expect(emailFromParts({ EMAIL_FROM: 'no-reply@x.cz' })).toEqual({ name: 'drobek', address: 'no-reply@x.cz' });
    expect(emailFromParts({ EMAIL_FROM: '<no-reply@x.cz>' })).toEqual({ name: 'drobek', address: 'no-reply@x.cz' });
    expect(emailFromParts({ EMAIL_FROM: 'Acme Apps <no-reply@x.cz>' })).toEqual({ name: 'Acme Apps', address: 'no-reply@x.cz' });
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
      ...DEFAULT_TIMEOUTS,
    });
    expect(smtpTransportOptions({ SMTP_HOST: 'smtp.hostinger.com', SMTP_PORT: '465', SMTP_SECURE: '1', SMTP_USER: 'u', SMTP_PASS: 'p' })).toMatchObject({
      port: 465,
      secure: true,
    });
    // mailpit: host alone, no auth; a user without a password sends no auth either.
    expect(smtpTransportOptions({ SMTP_HOST: 'mailpit', SMTP_PORT: '1025' })).toEqual({ host: 'mailpit', port: 1025, secure: false, ...DEFAULT_TIMEOUTS });
    expect(smtpTransportOptions({ SMTP_HOST: 'mailpit', SMTP_USER: 'u' })).not.toHaveProperty('auth');
  });

  it('SMTP timeouts: production defaults far below nodemailer\'s own, env overrides, an invalid value refuses the start', () => {
    expect(smtpTransportOptions({ SMTP_HOST: 'mailpit', SMTP_CONNECTION_TIMEOUT_MS: '5000', SMTP_GREETING_TIMEOUT_MS: ' 2000 ', SMTP_SOCKET_TIMEOUT_MS: '60000' })).toMatchObject({
      connectionTimeout: 5000,
      greetingTimeout: 2000,
      socketTimeout: 60000,
    });
    expect(emailConfigError({ SMTP_SOCKET_TIMEOUT_MS: '60000' })).toBeNull();
    const refused = emailConfigError({ SMTP_CONNECTION_TIMEOUT_MS: '10s', SMTP_GREETING_TIMEOUT_MS: '500', SMTP_SOCKET_TIMEOUT_MS: '30000' });
    expect(refused).toMatch(/^SMTP_CONNECTION_TIMEOUT_MS, SMTP_GREETING_TIMEOUT_MS must be milliseconds between 1000 and 120000/);
    expect(emailConfigError({ SMTP_SOCKET_TIMEOUT_MS: '600000' })).toMatch(/SMTP_SOCKET_TIMEOUT_MS/);
    // Read without the start check (a unit test, a script): an invalid value is its default.
    expect(smtpTransportOptions({ SMTP_HOST: 'mailpit', SMTP_GREETING_TIMEOUT_MS: 'soon' })).toMatchObject({ greetingTimeout: 10_000 });
  });

  it('a hung SMTP server fails the send after SMTP_GREETING_TIMEOUT_MS: it accepts the connection and never greets', async () => {
    const { port, close } = await silentSmtpServer(false);
    try {
      const started = Date.now();
      await expect(sendEmail(MAIL, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_GREETING_TIMEOUT_MS: '1000' })).rejects.toThrow(/greeting/i);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await close();
    }
  });

  it('a hung SMTP server fails the send after SMTP_SOCKET_TIMEOUT_MS: it greets, then goes silent', async () => {
    const { port, close } = await silentSmtpServer(true);
    try {
      const started = Date.now();
      await expect(sendEmail(MAIL, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SOCKET_TIMEOUT_MS: '1000' })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await close();
    }
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
