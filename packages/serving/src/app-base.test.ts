import { describe, expect, it } from 'vitest';
import { withAppBase } from './app-base.js';

const run = (html: string, base = '/apps/notes') => withAppBase(Buffer.from(html, 'latin1'), base).toString('latin1');
const HEAD = '<base href="/apps/notes/"><meta name="drobek-base" content="/apps/notes/">';

describe('withAppBase (path routing)', () => {
  it('puts <base> and the base meta first in <head> and prefixes root-absolute URLs', () => {
    const out = run(
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/main.css"><script type="module" src="/main.js"></script></head>' +
        '<body><img src="/img/a.png" srcset="/img/a.png 1x, /img/b.png 2x"><a href="/about">x</a><form action="/x"><button formaction="/y"></button></form><video poster="/p.jpg"></video></body></html>'
    );
    expect(out).toContain(`<head>${HEAD}<meta charset="utf-8">`);
    expect(out).toContain('href="/apps/notes/main.css"');
    expect(out).toContain('src="/apps/notes/main.js"');
    expect(out).toContain('src="/apps/notes/img/a.png"');
    expect(out).toContain('srcset="/apps/notes/img/a.png 1x, /apps/notes/img/b.png 2x"');
    expect(out).toContain('href="/apps/notes/about"');
    expect(out).toContain('action="/apps/notes/x"');
    expect(out).toContain('formaction="/apps/notes/y"');
    expect(out).toContain('poster="/apps/notes/p.jpg"');
  });

  it('leaves relative, protocol-relative, absolute and fragment URLs alone', () => {
    const out = run('<head></head><a href="about">a</a><a href="//cdn.example.com/x">b</a><a href="https://example.com/">c</a><a href="#top">d</a><img src="./a.png">');
    expect(out).toContain('href="about"');
    expect(out).toContain('href="//cdn.example.com/x"');
    expect(out).toContain('href="https://example.com/"');
    expect(out).toContain('href="#top"');
    expect(out).toContain('src="./a.png"');
    expect(out).not.toContain('/\\');
  });

  it('never rewrites inside script, style or textarea', () => {
    const src = '<head></head><script>const s = \'<img src="/x.png">\';</script><style>a{background:url(/x.png)}</style><textarea><a href="/y"></a></textarea>';
    const out = run(src);
    expect(out).toBe(src.replace('<head>', `<head>${HEAD}`));
  });

  it('handles unquoted and single-quoted values', () => {
    const out = run("<head></head><img src=/a.png><img src='/b.png'>");
    expect(out).toContain('src=/apps/notes/a.png');
    expect(out).toContain("src='/apps/notes/b.png'");
  });

  it('inserts after <html> or the doctype when there is no <head>', () => {
    expect(run('<!doctype html><html><p>x</p></html>')).toBe(`<!doctype html><html>${HEAD}<p>x</p></html>`);
    expect(run('<!DOCTYPE html><p>x</p>')).toBe(`<!DOCTYPE html>${HEAD}<p>x</p>`);
    expect(run('<p>x</p>')).toBe(`${HEAD}<p>x</p>`);
  });

  it('keeps every other byte (UTF-8 text) unchanged', () => {
    const html = Buffer.from('<head></head><p>Příliš žluťoučký kůň 🐴</p>', 'utf8');
    const out = withAppBase(html, '/apps/notes').toString('utf8');
    expect(out).toContain('Příliš žluťoučký kůň 🐴');
  });

  it('refuses a base that is not an app path (no markup injection)', () => {
    for (const bad of ['/apps/x"><script>', '/mcp', '/apps/', 'apps/x', '/apps/X']) {
      expect(() => withAppBase(Buffer.from('<head></head>'), bad), bad).toThrow(/invalid app base/);
    }
  });
});
