import { describe, expect, it } from 'vitest';
import { blank, elements, replaceSpans, startTagReader, type StartTag } from './markup.js';

/** 512 KB (the largest file a version may hold) of `unit`: the old regular expressions took seconds to minutes on each hostile input below. */
const fill = (unit: string): string => unit.repeat(Math.ceil((512 * 1024) / unit.length)).slice(0, 512 * 1024);

function ms(f: () => unknown): number {
  const started = performance.now();
  f();
  return performance.now() - started;
}

/** mulberry32: the same generated texts on every run. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tags(text: string): StartTag[] {
  const out: StartTag[] = [];
  const next = startTagReader(text);
  for (let t = next(0); t; t = next(t.end)) out.push(t);
  return out;
}

/** The scans the reference and readiness checks used before: what each scan of markup.ts must find, on any text. */
const COMMENT = /<!--[\s\S]*?-->/g;
const RAW_TEXT = /(<(script|style|template|title|textarea)\b[^>]*>)([\s\S]*?)(<\/\2\s*>|$)/gi;

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

describe('startTagReader', () => {
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

  it('tries every < after a broken tag, also one inside it, as the regular expression did', () => {
    expect(tags('<a href="x"title="y"><img src=b.png>').map((t) => t.name)).toEqual(['img']);
    expect(tags('<div <p>').map((t) => [t.name, t.attrs.map((a) => a.name)])).toEqual([['div', ['<p']]]);
    expect(tags('<a<b>').map((t) => t.name)).toEqual(['b']);
    expect(tags('<a title="<img src=x.png>" =>').map((t) => t.name)).toEqual(['img']);
    expect(tags('<template x-if="n >          </template>\n<link rel="icon" href="/favicon.svg">').map((t) => t.name)).toEqual(['link']);
  });

  it('reads any text, broken or not, exactly as the regular expression did', () => {
    const rnd = random(421);
    const alphabet = ['<', '<a', '<a', '<b', ' ', ' ', '\n', '"', "'", '=', '=', '>', '/', 'x', 'y-z', '<script>', '</script>'];
    for (let i = 0; i < 5000; i++) {
      const text = Array.from({ length: Math.floor(rnd() * 40) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
      expect(tags(text)).toEqual(regexTags(text));
    }
  });
});

describe('well-formed pages (seeded fuzz against the old regular expressions)', () => {
  function page(rnd: () => number): string {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
    const some = (list: readonly string[], max: number): string => Array.from({ length: Math.floor(rnd() * (max + 1)) }, () => pick(list)).join('');
    const space = ['', ' ', '\n', '\t', '  '];
    const gap = [' ', '\n  ', '\t', '  ', ' \n'];
    const attr = (): string => {
      const name = pick(['href', 'src', 'class', 'data-x', ':class', '@click', 'x-data', 'aria-label', 'ID', 'Type', 'hidden', 'v-on:click.prevent', 'content', 'rel']);
      const eq = `${pick(space)}=${pick(space)}`;
      switch (pick(['none', 'double', 'single', 'bare'])) {
        case 'none':
          return name;
        case 'double':
          return `${name}${eq}"${some(['a', ' ', '>', '<', "'", '=', '/', '\n', '&amp;', '<img src=x.png>', '{"k":1}'], 6)}"`;
        case 'single':
          return `${name}${eq}'${some(['b', ' ', '>', '<', '"', '=', '/', '&quot;', '<a href=y>'], 6)}'`;
        default:
          return `${name}${eq}${pick(['x', '/a.png', 'a/b.css?v=1&x=2', '#top', 'image/svg+xml', 'x/', '1', 'a=b', 'https://cdn.example/x.js'])}`;
      }
    };
    const startTag = (name: string): string =>
      `<${name}${Array.from({ length: Math.floor(rnd() * 4) }, () => pick(gap) + attr()).join('')}${pick(['>', '>', '/>', ' />', ' >', '\n>'])}`;
    const raw = ['if (a<b) x();', '<b>bold</b>', '</div>', 'a < b', '&amp;', "'single'", '"double"', '\n', '<img src="in-raw.png">', 'x>y', 'url(a.png)'];
    const nodes: string[] = [];
    for (let n = Math.floor(rnd() * 40); n > 0; n--) {
      switch (pick(['text', 'element', 'element', 'end', 'comment', 'raw'])) {
        case 'text':
          nodes.push(pick(['Hello', ' 3 > 2 ', ' a = b ', '&amp;', '\n', ' x < y ', "it's", '"q"', '/', '=>', ' ']));
          break;
        case 'element':
          nodes.push(startTag(pick(['div', 'p', 'a', 'img', 'link', 'meta', 'input', 'br', 'my-widget', 'svg', 'path', 'SECTION', 'Td', 'h1', 'source', 'video', 'HTML'])));
          break;
        case 'end':
          nodes.push(pick(['</div>', '</p>', '</a>', '</my-widget >', '</SECTION>']));
          break;
        case 'comment':
          nodes.push(`<!--${some([' note ', '<a href="x">', '\n', ' x - y ', '<script>', '<title>'], 4)}-->`);
          break;
        default: {
          const name = pick(['script', 'style', 'title', 'textarea', 'template', 'SCRIPT', 'Style']);
          const close = pick(['', '', ' ', '\n']);
          nodes.push(`${startTag(name)}${some(raw, 5)}</${pick([name, name.toLowerCase(), name.toUpperCase()])}${close}>`);
        }
      }
    }
    return nodes.join('');
  }

  it('finds what the regular expressions found on 2,000 generated pages', () => {
    const rnd = random(87);
    for (let i = 0; i < 2000; i++) {
      const html = page(rnd);
      const uncommented = replaceSpans(html, '<!--', '-->', blank);
      expect(uncommented).toBe(html.replace(COMMENT, blank));

      const found = [...elements(uncommented, ['script', 'style', 'template', 'title', 'textarea'])];
      const expected = [...uncommented.matchAll(RAW_TEXT)].map((m) => ({
        name: m[2].toLowerCase(),
        start: m.index,
        contentStart: m.index + m[1].length,
        contentEnd: m.index + m[1].length + m[3].length,
        end: m.index + m[0].length,
        closed: m[4] !== '',
      }));
      expect(found).toEqual(expected);

      expect(tags(uncommented)).toEqual(regexTags(uncommented));
      let blanked = '';
      let from = 0;
      for (const el of found) {
        blanked += uncommented.slice(from, el.contentStart) + blank(uncommented.slice(el.contentStart, el.contentEnd));
        from = el.contentEnd;
      }
      blanked += uncommented.slice(from);
      expect(tags(blanked)).toEqual(regexTags(blanked));
    }
  });
});

describe('linear time on hostile input (512 KB)', () => {
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
