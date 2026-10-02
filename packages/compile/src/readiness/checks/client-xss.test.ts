import { describe, expect, it } from 'vitest';
import { clientXss } from './client-xss.js';
import type { CheckFinding } from '../types.js';

const run = (files: Record<string, string | Buffer>) => clientXss.run({ files: new Map(Object.entries(files)), modules: [] }) as CheckFinding[];
const codes = (file: string, src: string) => run({ [file]: src }).map((f) => `${f.code}@${f.line}`);
const js = (src: string) => codes('src/main.ts', src);
const tsx = (src: string) => codes('src/App.tsx', src);

describe('client-xss check: HTML sinks', () => {
  it('reports innerHTML/outerHTML set from a value, with file and line', () => {
    const found = run({ 'src/main.ts': "const root = document.getElementById('app')!;\nroot.innerHTML = record.text;\nel.outerHTML += name;" });
    expect(found).toEqual([
      expect.objectContaining({ code: 'xss_html_sink', file: 'src/main.ts', line: 2 }),
      expect.objectContaining({ code: 'xss_html_sink', file: 'src/main.ts', line: 3 }),
    ]);
    expect(found[0].message).toContain('`.innerHTML`');
  });

  it('passes literals and templates without substitutions', () => {
    expect(js("root.innerHTML = '<h1>Ready</h1>';\nlist.innerHTML = \"\";\nx.innerHTML = `<p>\n  hi\n</p>`;\ny.innerHTML = null")).toEqual([]);
    expect(js("el.innerHTML = '<b>' + 'x' + '</b>';\nel.innerHTML = open ? '<i>▲</i>' : '<i>▼</i>';")).toEqual([]);
  });

  it('reports a template with a raw substitution, passes one that escapes every substitution', () => {
    expect(js('li.innerHTML = `<b>${row.name}</b>`;')).toEqual(['xss_html_sink@1']);
    expect(js('li.innerHTML = `<b>${escapeHtml(row.name)}</b> (${row.tags.length}) ${price.toFixed(2)}`;')).toEqual([]);
    expect(js("li.innerHTML = '<b>' + esc(row.name) + '</b>';")).toEqual([]);
    expect(js('el.innerHTML = DOMPurify.sanitize(html);')).toEqual([]);
  });

  it('passes a joined map of escaping templates, reports a raw one', () => {
    expect(js("ul.innerHTML = items.map((i) => `<li>${esc(i.title)}</li>`).join('');")).toEqual([]);
    expect(js("ul.innerHTML = items.map((i) => `<li>${i.title}</li>`).join('');")).toEqual(['xss_html_sink@1']);
  });

  it('reports insertAdjacentHTML and document.write with a value, not with a literal', () => {
    expect(js("el.insertAdjacentHTML('beforeend', html);\nel.insertAdjacentHTML('beforeend', '<hr>');\ndocument.write(msg);\ndocument.write('<p>ok</p>');")).toEqual([
      'xss_html_sink@1',
      'xss_html_sink@3',
    ]);
  });

  it('reports dangerouslySetInnerHTML unless __html is a literal', () => {
    expect(tsx('<div dangerouslySetInnerHTML={{ __html: post.body }} />')).toEqual(['xss_html_sink@1']);
    expect(tsx('<div dangerouslySetInnerHTML={{ __html: "<br>" }} />')).toEqual([]);
    expect(tsx('<div dangerouslySetInnerHTML={props} />')).toEqual(['xss_html_sink@1']);
    expect(js("h('div', { dangerouslySetInnerHTML: { __html: md(text) } })")).toEqual(['xss_html_sink@1']);
  });

  it('ignores reads, comparisons, strings and comments', () => {
    expect(js("const t = el.innerHTML;\nif (el.innerHTML === x) {}\nconst doc = 'el.innerHTML = x';\n// el.innerHTML = x\n/* eval(x) */")).toEqual([]);
  });

  it('keeps the expression to its statement when semicolons are omitted', () => {
    expect(js("el.innerHTML = ''\nrender(state)")).toEqual([]);
    expect(js("el.innerHTML = '<p>'\n  + name\n  + '</p>'")).toEqual(['xss_html_sink@1']);
  });
});

describe('client-xss check: eval', () => {
  it('reports eval, new Function and string timers', () => {
    expect(js("eval(code);\nconst f = new Function('a', body);\nsetTimeout('tick()', 100);\nwindow.setInterval(`go(${n})`, 5);")).toEqual([
      'xss_eval@1',
      'xss_eval@2',
      'xss_eval@3',
      'xss_eval@4',
    ]);
  });

  it('passes function timers, methods named eval and the Function type', () => {
    expect(js('setTimeout(() => tick(), 100);\nsetTimeout(tick, 100);\nparser.eval(expr);\nconst cb: Function = f;\nclass M { eval(x) { return x; } }')).toEqual([]);
  });
});

describe('client-xss check: URL sinks', () => {
  it('reports href/src from a value, passes literals and fixed-scheme URLs', () => {
    expect(js("a.href = record.url;\na.href = '/items/' + id;\na.href = `https://maps.example.com/?q=${q}`;\nframe.src = url;\nlocation.href = '#top';")).toEqual([
      'xss_url_sink@1',
      'xss_url_sink@4',
    ]);
  });

  it('passes image/media src and object URLs', () => {
    expect(js('img.src = photo.url;\nthis.avatarEl.src = u;\npreview.src = URL.createObjectURL(file);\nframe.src = reader.result;')).toEqual([]);
  });

  it('reports setAttribute and location navigation with a value', () => {
    expect(js("a.setAttribute('href', link);\na.setAttribute('title', link);\nlocation.assign(next);\nwindow.location = target;\nlocation.replace('/login');")).toEqual([
      'xss_url_sink@1',
      'xss_url_sink@3',
      'xss_url_sink@4',
    ]);
  });

  it('reports JSX src only on frames and scripts, never JSX href', () => {
    expect(tsx('<a href={item.url}>open</a>\n<a href={`/items/${id}`}>{name}</a>\n<img src={item.image} alt="" />')).toEqual([]);
    expect(tsx('<iframe src={embed.url} />')).toEqual(['xss_url_sink@1']);
    expect(tsx('<iframe src={safeUrl(embed.url)} />')).toEqual([]);
  });

  it('does not read JSX rules into plain .ts files', () => {
    expect(js('const o = { href: x };\nlet href = x;')).toEqual([]);
  });
});

describe('client-xss check: files', () => {
  it('scans inline scripts in HTML with the page line numbers, skips data and external scripts', () => {
    const html = [
      '<!doctype html>',
      '<html><head><title>T</title>',
      '<script type="application/json">{"innerHTML": 1}</script>',
      '<script src="/app.js"></script>',
      '</head><body>',
      '<script>',
      "  const out = document.querySelector('#out');",
      '  out.innerHTML = location.hash.slice(1);',
      '</script>',
      '</body></html>',
    ].join('\n');
    expect(codes('index.html', html)).toEqual(['xss_html_sink@8']);
  });

  it('skips binaries, stylesheets, vendored and minified files', () => {
    const bad = 'el.innerHTML = x;';
    expect(run({ 'a.png': Buffer.from(bad), 'a.css': bad, 'vendor/lib.js': bad, 'src/chart.min.js': bad, 'README.md': bad })).toEqual([]);
  });

  it('reports one finding per code and line', () => {
    expect(js('a.innerHTML = x; b.innerHTML = y;')).toEqual(['xss_html_sink@1']);
  });

  it('survives regexes, JSX text with apostrophes and nested templates', () => {
    const src = [
      "const re = /['\"`]/g;",
      'const s = x.replace(re, "");',
      "const view = <p>Don't {name}</p>;",
      'const t = `${a ? `${b}` : `c`}`;',
      'el.innerHTML = t;',
    ].join('\n');
    expect(tsx(src)).toEqual(['xss_html_sink@5']);
  });

  it('never throws on a pathological file', () => {
    expect(js('`${`${`${'.repeat(200))).toEqual([]);
    expect(js('el.innerHTML = ')).toEqual([]);
  });
});

describe('client-xss check: hostile HTML', () => {
  const fill = (unit: string) => unit.repeat(Math.ceil((256 * 1024) / unit.length));
  const ms = (f: () => unknown) => {
    const started = performance.now();
    f();
    return performance.now() - started;
  };

  it.each([
    ['unclosed scripts', fill('<script>')],
    ['script start tags without >', fill('<script')],
    ['thousands of empty scripts', fill('<script></script>\n')],
  ])('scans 256 KB of %s in linear time', (_what, html) => {
    expect(ms(() => run({ 'index.html': html }))).toBeLessThan(500);
  });

  it('keeps the page line numbers across many inline scripts', () => {
    expect(codes('index.html', `${'<script></script>\n'.repeat(3)}<script>\nel.innerHTML = x;\n</script>`)).toEqual(['xss_html_sink@5']);
  });
});
