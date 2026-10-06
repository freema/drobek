import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANALYTICS_RETENTION_DAYS,
  analyticsEnabled,
  analyticsRetentionDays,
  clampTrafficDays,
  classifyPageView,
  isBotUserAgent,
  referrerHost,
  shapeTraffic,
  trafficPath,
  trafficRange,
  type PageViewInput,
} from './traffic.js';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function view(over: Partial<PageViewInput> = {}): PageViewInput {
  return {
    path: '/',
    host: 'hello.apps.example.com',
    userAgent: CHROME,
    referer: null,
    clientIp: '203.0.113.7',
    secFetchDest: 'document',
    purpose: null,
    dashboardOrigin: 'https://dash.example.com',
    ...over,
  };
}

describe('isBotUserAgent', () => {
  it('knows crawlers, link previews, monitors, headless browsers and HTTP libraries', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'AdsBot-Google (+http://www.google.com/adsbot.html)',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Twitterbot/1.0',
      'WhatsApp/2.23.20.0',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36',
      'curl/8.7.1',
      'Wget/1.21.4',
      'python-requests/2.32.3',
      'Go-http-client/2.0',
      'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
      'UptimeRobot/2.0',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      '',
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(true);
    }
    expect(isBotUserAgent(null)).toBe(true);
  });

  it('lets people\'s browsers through', () => {
    for (const ua of [CHROME, FIREFOX, IPHONE, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0']) {
      expect(isBotUserAgent(ua), ua).toBe(false);
    }
  });
});

describe('classifyPageView', () => {
  it('a browser opening a page is a person', () => {
    expect(classifyPageView(view())).toBe('human');
    expect(classifyPageView(view({ secFetchDest: null }))).toBe('human');
    expect(classifyPageView(view({ secFetchDest: 'iframe', referer: 'https://someone-else.example/' }))).toBe('human');
  });

  it('a bot user agent counts apart', () => {
    expect(classifyPageView(view({ userAgent: 'Googlebot/2.1' }))).toBe('bot');
    expect(classifyPageView(view({ userAgent: null }))).toBe('bot');
  });

  it('never counts drobek\'s own health and smoke checks', () => {
    expect(classifyPageView(view({ userAgent: 'drobek-healthcheck/1' }))).toBe('skip');
    expect(classifyPageView(view({ userAgent: 'drobek-smoke' }))).toBe('skip');
    expect(classifyPageView(view({ userAgent: 'drobek/0.9.0' }))).toBe('skip');
  });

  it('a prefetch, a fetch() of the HTML or the dashboard\'s thumbnail is no visit', () => {
    expect(classifyPageView(view({ purpose: 'prefetch' }))).toBe('skip');
    expect(classifyPageView(view({ purpose: 'prefetch;prerender' }))).toBe('skip');
    expect(classifyPageView(view({ secFetchDest: 'empty' }))).toBe('skip');
    expect(classifyPageView(view({ secFetchDest: 'script' }))).toBe('skip');
    expect(classifyPageView(view({ secFetchDest: 'iframe', referer: 'https://dash.example.com/workspaces/me/apps' }))).toBe('skip');
  });
});

describe('referrerHost', () => {
  it('keeps only the host of an external referrer', () => {
    expect(referrerHost('https://news.ycombinator.com/item?id=1#x', 'hello.apps.example.com')).toBe('news.ycombinator.com');
    expect(referrerHost('http://WWW.Example.org:8080/a/b?token=secret', 'hello.apps.example.com')).toBe('www.example.org');
  });

  it('drops navigation inside the app, other schemes and junk', () => {
    expect(referrerHost('https://hello.apps.example.com/page', 'hello.apps.example.com:443')).toBeNull();
    expect(referrerHost('https://hello.apps.example.com/page', 'HELLO.apps.example.com')).toBeNull();
    expect(referrerHost('android-app://com.google.android.gm/', 'h.example')).toBeNull();
    expect(referrerHost('not a url', 'h.example')).toBeNull();
    expect(referrerHost('', 'h.example')).toBeNull();
    expect(referrerHost(null, 'h.example')).toBeNull();
    expect(referrerHost('http://[::1]/', 'h.example')).toBeNull();
  });
});

describe('trafficPath', () => {
  it('strips the query and fragment and bounds the length', () => {
    expect(trafficPath('/a/b?email=x@y.z#top')).toBe('/a/b');
    expect(trafficPath('about')).toBe('/about');
    expect(trafficPath(undefined)).toBe('/');
    expect(trafficPath(`/${'x'.repeat(500)}`)).toHaveLength(256);
  });
});

describe('env', () => {
  it('ANALYTICS_ENABLED is on unless turned off', () => {
    expect(analyticsEnabled({})).toBe(true);
    expect(analyticsEnabled({ ANALYTICS_ENABLED: '1' })).toBe(true);
    expect(analyticsEnabled({ ANALYTICS_ENABLED: '0' })).toBe(false);
    expect(analyticsEnabled({ ANALYTICS_ENABLED: 'false' })).toBe(false);
  });

  it('ANALYTICS_RETENTION_DAYS defaults to 90 and ignores nonsense', () => {
    expect(analyticsRetentionDays({})).toBe(DEFAULT_ANALYTICS_RETENTION_DAYS);
    expect(analyticsRetentionDays({ ANALYTICS_RETENTION_DAYS: '30' })).toBe(30);
    expect(analyticsRetentionDays({ ANALYTICS_RETENTION_DAYS: '-1' })).toBe(90);
    expect(analyticsRetentionDays({ ANALYTICS_RETENTION_DAYS: 'x' })).toBe(90);
  });

  it('a requested range stays within 1 day and the retention', () => {
    expect(clampTrafficDays(undefined, 90)).toBe(30);
    expect(clampTrafficDays(7, 90)).toBe(7);
    expect(clampTrafficDays(365, 90)).toBe(90);
    expect(clampTrafficDays(0, 90)).toBe(1);
    expect(clampTrafficDays(undefined, 14)).toBe(14);
  });
});

describe('shapeTraffic', () => {
  it('zero-fills the range, sums the totals and ranks the top lists', () => {
    const range = trafficRange(3, new Date('2026-10-06T10:00:00Z'));
    expect(range.days).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
    const view = shapeTraffic({
      range,
      daily: new Map([
        ['2026-10-04', { views: 4, visitors: 2, botViews: 1 }],
        ['2026-10-06', { views: 6, visitors: 3, botViews: 4 }],
      ]),
      paths: new Map([
        ['/', 7],
        ['/about', 3],
        ['/zero', 0],
      ]),
      referrers: new Map([['news.example', 2]]),
      topLimit: 1,
    });
    expect(view.series.map((d) => d.views)).toEqual([4, 0, 6]);
    expect(view.totals).toEqual({ views: 10, visitors: 5, bot_views: 5, bot_share: 0.333 });
    expect(view.top_paths).toEqual([{ path: '/', views: 7 }]);
    expect(view.top_referrers).toEqual([{ host: 'news.example', views: 2 }]);
  });

  it('no views at all → bot_share null', () => {
    const view = shapeTraffic({ range: trafficRange(1), daily: new Map(), paths: new Map(), referrers: new Map() });
    expect(view.totals.bot_share).toBeNull();
    expect(view.series).toHaveLength(1);
  });
});
