import { describe, expect, it } from 'vitest';
import { readHtml } from './html.js';

describe('readHtml', () => {
  it('reads start tags with lines and decoded attributes, skipping comments and raw text', () => {
    const page = readHtml(
      [
        '<!doctype html>',
        '<html><head>',
        '<!-- <meta name="description" content="old"> -->',
        '<title><meta name="x"></title>',
        '<script>document.write(\'<link rel="icon">\')</script>',
        '<META NAME=description content="Tom &amp; Jerry">',
        '</head><body>',
        '<textarea><img src="no.png"></textarea>',
        '<img src="yes.png" alt>',
        '</body></html>',
      ].join('\n')
    );
    expect(page.tags.map((t) => [t.name, t.line])).toEqual([
      ['html', 2],
      ['head', 2],
      ['title', 4],
      ['script', 5],
      ['meta', 6],
      ['body', 7],
      ['textarea', 8],
      ['img', 9],
    ]);
    expect(page.tags[4].attrs).toEqual(new Map([['name', 'description'], ['content', 'Tom & Jerry']]));
    expect(page.tags[7].attrs).toEqual(new Map([['src', 'yes.png'], ['alt', '']]));
    expect(page.head.map((t) => t.name)).toEqual(['html', 'head', 'title', 'script', 'meta']);
    expect(page.headLine).toBe(2);
  });

  it.each([
    ['unclosed tags', '<a '],
    ['unclosed tags with values', '<a x=y'],
    ['raw-text start tags without >', '<script'],
    ['unclosed raw-text elements', '<title>'],
    ['unclosed comments', '<!--'],
  ])('reads 256 KB of %s in linear time', (_what, unit) => {
    const source = unit.repeat(Math.ceil((256 * 1024) / unit.length));
    const started = performance.now();
    readHtml(source);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
