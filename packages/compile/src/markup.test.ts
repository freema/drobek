import { describe, expect, it } from 'vitest';
import { blank, elements, nextStartTag, replaceSpans, type StartTag } from './markup.js';

/** 256 KB of `unit`: the old regular expressions took seconds to minutes on each hostile input below. */
const fill = (unit: string): string => unit.repeat(Math.ceil((256 * 1024) / unit.length));

function ms(f: () => unknown): number {
  const started = performance.now();
  f();
  return performance.now() - started;
}

function tags(text: string): StartTag[] {
  const out: StartTag[] = [];
  for (let t = nextStartTag(text, 0); t; t = nextStartTag(text, t.end)) out.push(t);
  return out;
}

/** The start-tag scan the reference and readiness checks used before; the reference for well-formed markup. */
function regexTags(text: string): StartTag[] {
  const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
  const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  return [...text.matchAll(TAG)].map((m) => ({
    name: m[1],
    start: m.index,
    end: m.index + m[0].length,
    attrs: [...m[2].matchAll(ATTR)].map((a) => ({ name: a[1], value: a[2] ?? a[3] ?? a[4], at: m.index + 1 + m[1].length + a.index })),
  }));
}

const PAGE = `<!doctype html>
<HTML lang=cs>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Shifts</title>
  <link rel="icon" href='/favicon.svg' type=image/svg+xml>
  <link rel="stylesheet" href="/main.css"/>
  <script type="module" src="/main.js" defer></script>
</head>
<body class="dark">
  <div id=app data-state='{"open":true}' :class="{ active: on }" @click="toggle()" hidden>
    <img src="img/a.png" alt="a > b, a < b" title="it's">
    <a
      href="/about?x=1&amp;y=2"
      target = "_blank"
    >About</a>
    <my-widget x-data="{ n: 0 }"></my-widget>
    <svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>
    <input type="checkbox" checked><br/>
    3 > 2 and x = y
  </div>
</body>
</HTML>
`;

describe('replaceSpans', () => {
  it('replaces every closed span like /open[\\s\\S]*?close/g', () => {
    const html = 'a<!-- x -->b<!---->c<!-- y\n -->d';
    expect(replaceSpans(html, '<!--', '-->', blank)).toBe(html.replace(/<!--[\s\S]*?-->/g, blank));
    const css = 'a{}/* x */b/**/c/*/ y */';
    expect(replaceSpans(css, '/*', '*/', () => '')).toBe(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  });

  it('leaves an open without a close, and the rest of the text, as it is', () => {
    expect(replaceSpans('a<!--b-->c<!--d<!--e', '<!--', '-->', () => '')).toBe('ac<!--d<!--e');
    expect(replaceSpans('<!-->x', '<!--', '-->', () => '')).toBe('<!-->x');
    expect(replaceSpans('x<b>y<z', '<', '>', () => '')).toBe('xy<z');
  });

  it('keeps newlines when blanking, so line numbers stay', () => {
    expect(replaceSpans('a<!--\n\n-->b', '<!--', '-->', blank)).toBe('a    \n\n   b');
  });
});

describe('elements', () => {
  it('reads each element and its raw content, the end tag in any case', () => {
    const html = '<p><script type="module">if (a<b) x();</SCRIPT ><style>a{}</style>';
    expect([...elements(html, ['script', 'style'])].map((e) => [e.name, html.slice(e.contentStart, e.contentEnd), e.closed])).toEqual([
      ['script', 'if (a<b) x();', true],
      ['style', 'a{}', true],
    ]);
  });

  it('matches whole names only', () => {
    expect([...elements('<titles>x</titles><title>y</title>', ['title'])].map((e) => e.start)).toEqual([18]);
  });

  it('runs an unclosed element to the end of the text and stops at a start tag without >', () => {
    const html = '<style>a{}</style><script>let x = 1;<style>';
    const found = [...elements(html, ['script', 'style'])];
    expect(found.map((e) => [e.name, e.closed, e.contentEnd])).toEqual([
      ['style', true, 10],
      ['script', false, html.length],
    ]);
    expect([...elements('<script src=x.js', ['script'])]).toEqual([]);
  });
});

describe('nextStartTag', () => {
  it('reads a well-formed page exactly as the regular expression did', () => {
    const found = tags(PAGE);
    expect(found).toEqual(regexTags(PAGE));
    expect(found.map((t) => t.name)).toContain('my-widget');
    const img = found.find((t) => t.name === 'img')!;
    expect(img.attrs.map((a) => [a.name, a.value])).toEqual([
      ['src', 'img/a.png'],
      ['alt', 'a > b, a < b'],
      ['title', "it's"],
    ]);
    expect(PAGE.slice(img.attrs[1].at).startsWith('alt=')).toBe(true);
    expect(found.find((t) => t.name === 'input')!.attrs.map((a) => [a.name, a.value])).toEqual([
      ['type', 'checkbox'],
      ['checked', undefined],
    ]);
  });

  it('goes on where a broken tag broke off, as a browser does', () => {
    expect(tags('<a href="x"title="y"><img src=b.png>').map((t) => t.name)).toEqual(['img']);
    expect(tags('<div <p>').map((t) => [t.name, t.attrs.map((a) => a.name)])).toEqual([['div', ['<p']]]);
    expect(tags('<a<b>').map((t) => t.name)).toEqual(['b']);
    expect(tags('<a title="<img src=x.png>" =>').map((t) => t.name)).toEqual([]);
  });
});

describe('linear time on hostile input (256 KB)', () => {
  it.each([
    ['unclosed tags', '<a '],
    ['unclosed tags with values', '<a x=y'],
    ['an unclosed quote', '<a x="'],
    ['a chain of quoted values that each start a tag', ' x="<a z" y=\'<a w\''],
  ])('start tags: %s', (_name, unit) => {
    const text = `<a${fill(unit)}`;
    expect(ms(() => tags(text))).toBeLessThan(500);
  });

  it.each([
    ['comments', '<!--', '-->'],
    ['CSS comments', '/* ', '*/'],
    ['tags', '<', '>'],
  ])('replaceSpans: unclosed %s', (_name, open, close) => {
    const text = fill(open);
    expect(ms(() => replaceSpans(text, open, close, blank))).toBeLessThan(500);
  });

  it.each([
    ['start tags without >', '<script'],
    ['elements without an end tag', '<script>'],
    ['end tags that never close', '<script></script '],
  ])('elements: %s', (_name, unit) => {
    const text = fill(unit);
    expect(ms(() => [...elements(text, ['script', 'style'])])).toBeLessThan(500);
  });
});
