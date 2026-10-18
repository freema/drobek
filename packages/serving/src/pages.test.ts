import { describe, expect, it } from 'vitest';
import { PLATFORM_COLORS } from '@drobek/core/platform-theme';
import { errorPage, lockedPage, missingPage, passwordPage, platformPageShell, UNLOCK_PATH } from './pages.js';

const PAGES: Record<string, string> = {
  missing: missingPage('no-app'),
  password: passwordPage({ next: '/' }),
  error: errorPage('Unavailable', 'This app cannot be unlocked right now.'),
  locked: lockedPage({ reasonLabel: 'Phishing', termsUrl: 'https://drobek.test/terms' }),
};

describe('the app-host pages share the platform shell', () => {
  for (const [page, html] of Object.entries(PAGES)) {
    it(`${page}: marker, viewport, light + dark theme, mascot, no script`, () => {
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain(`data-drobek-page="${page}"`);
      expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
      expect(html).toContain('@media (prefers-color-scheme:dark)');
      expect(html).toContain(PLATFORM_COLORS.light.bg);
      expect(html).toContain(PLATFORM_COLORS.dark.bg);
      expect(html).toContain('<svg width="32" height="22" aria-hidden="true"');
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\son[a-z]+=/i);
      expect(html.match(/<style>/g)).toHaveLength(1);
    });
  }

  it('escapes the title, heading and marker; the body and foot are the caller’s HTML', () => {
    const html = platformPageShell({ page: 'x"y', title: '<t>', heading: 'a & b', body: '<p>ok</p>', footer: '<a href="/">f</a>' });
    expect(html).toContain('data-drobek-page="x&quot;y"');
    expect(html).toContain('<title>&lt;t&gt;</title>');
    expect(html).toContain('<h1>a &amp; b</h1>');
    expect(html).toContain('<p>ok</p>');
    expect(html).toContain('<p class="drobek-foot"><a href="/">f</a></p>');
    expect(platformPageShell({ page: 'p', title: 't', heading: 'h', body: '' })).not.toContain('drobek-foot"');
  });
});

describe('page texts', () => {
  it('a missing page says what happened and what to do next', () => {
    expect(missingPage('no-app')).toContain('There is no app at this address.');
    expect(missingPage('no-app')).toContain('Check the address');
    expect(missingPage('not-published')).toContain('has not been published yet');
    expect(missingPage('no-file')).toContain('<a href="/">Go to the start page</a>');
    expect(missingPage('no-version')).not.toContain('Go to the start page');
  });

  it('the password form posts to the unlock path, keeps `next` escaped and shows the error as an alert', () => {
    const html = passwordPage({ next: '/a?b="c"', error: 'wrong' });
    expect(html).toContain(`<form method="POST" action="${UNLOCK_PATH}">`);
    expect(html).toContain('value="/a?b=&quot;c&quot;"');
    expect(html).toContain('This app is password protected');
    expect(html).toMatch(/role="alert">Incorrect password/);
    expect(passwordPage({ next: '/', error: 'rate_limited' })).toContain('Too many attempts');
    expect(passwordPage({ next: '/' })).not.toContain('role="alert"');
  });

  it('the 451 page names the reason category and links the terms in its foot', () => {
    const html = lockedPage({ reasonLabel: 'Malware <x>', termsUrl: 'https://drobek.test/terms?a=1&b=2' });
    expect(html).toContain('(malware &lt;x&gt;)');
    expect(html).toContain('<p class="drobek-foot"><a href="https://drobek.test/terms?a=1&amp;b=2" rel="noopener noreferrer">Terms of service</a></p>');
  });

  it('an error page escapes its texts', () => {
    expect(errorPage('<b>', 'x & y')).toContain('<p>x &amp; y</p>');
    expect(errorPage('<b>', 'x & y')).toContain('<h1>&lt;b&gt;</h1>');
  });
});
