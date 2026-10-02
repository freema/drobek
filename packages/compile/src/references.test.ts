import { describe, expect, it } from 'vitest';
import { APP_CSP_SOURCES, appCspAllows, appCspFetchDirectives } from './app-csp.js';
import { Compiler } from './compiler.js';
import { scanReferences } from './references.js';

const MAIN = { main: 'src/main.tsx' };

function scan(files: Record<string, string>, opts: { entries?: Record<string, string>; imports?: Record<string, string>; servedPaths?: string[] } = {}) {
  const map = new Map(Object.entries(files));
  return scanReferences({
    files: map,
    text: map,
    config: { entries: opts.entries ?? {}, imports: opts.imports ?? {} },
    servedPaths: opts.servedPaths,
  });
}

const page = (head: string, body = '') => `<!doctype html>\n<html>\n<head>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

describe('app CSP sources', () => {
  it('match the policy line by line', () => {
    expect(appCspFetchDirectives()).toEqual([
      "default-src 'self'",
      "script-src 'self' https://esm.sh 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https:",
      "connect-src 'self' https://esm.sh",
      "media-src 'self' blob: https:",
    ]);
  });

  it('match host and scheme sources, never self', () => {
    expect(appCspAllows('connect-src', new URL('https://esm.sh/x'))).toBe(true);
    expect(appCspAllows('connect-src', new URL('https://api.example.com/x'))).toBe(false);
    expect(appCspAllows('connect-src', new URL('http://esm.sh/x'))).toBe(false);
    expect(appCspAllows('img-src', new URL('https://cdn.example.com/a.png'))).toBe(true);
    expect(appCspAllows('img-src', new URL('http://cdn.example.com/a.png'))).toBe(false);
    expect(appCspAllows('default-src', new URL('https://cdn.example.com/m.json'))).toBe(false);
    expect(APP_CSP_SOURCES['script-src']).toContain('https://esm.sh');
  });
});

describe('missing_reference', () => {
  it('warns about a missing favicon with file and line', () => {
    const w = scan({ 'index.html': page('<link rel="icon" href="/favicon.ico">') });
    expect(w).toEqual([
      expect.objectContaining({ code: 'missing_reference', file: 'index.html', line: 4 }),
    ]);
    expect(w[0].text).toContain('favicon.ico');
    expect(w[0].text).toContain('404');
  });

  it('does not warn when the file exists, is an uploaded asset or a build output', () => {
    expect(scan({ 'index.html': page('<link rel="icon" href="/favicon.ico">'), 'favicon.ico': '' })).toEqual([]);
    expect(scan({ 'index.html': page('<img src="img/hero.jpg">') }, { servedPaths: ['img/hero.jpg'] })).toEqual([]);
    expect(
      scan(
        { 'index.html': page('<link rel="stylesheet" href="/main.css"><script type="module" src="/main.js"></script>'), 'src/main.tsx': '' },
        { entries: MAIN }
      )
    ).toEqual([]);
  });

  it('checks every HTML source kind, relative to the page', () => {
    const w = scan({
      'docs/page.html': page(
        [
          '<link rel="stylesheet" href="style.css">',
          '<link rel="apple-touch-icon" href="../touch.png">',
          '<meta name="msapplication-TileImage" content="/tile.png">',
          '<script src="./app.js"></script>',
        ].join('\n'),
        ['<img src="logo.png">', '<a href="/about.html">About</a>', '<video src="clip.mp4"><source src="clip.webm"></video>'].join('\n')
      ),
    });
    expect(w.map((m) => m.text.match(/points to (\S+),/)?.[1])).toEqual([
      'docs/style.css',
      'touch.png',
      'tile.png',
      'docs/app.js',
      'docs/logo.png',
      'about.html',
      'docs/clip.mp4',
      'docs/clip.webm',
    ]);
  });

  it('checks web manifest icons relative to the manifest', () => {
    const manifest = JSON.stringify({ name: 'x', icons: [{ src: 'icons/192.png' }, { src: 'icons/512.png' }] }, null, 2);
    const w = scan({
      'index.html': page('<link rel="manifest" href="/app.webmanifest">'),
      'app.webmanifest': manifest,
      'icons/192.png': '',
    });
    expect(w).toEqual([expect.objectContaining({ code: 'missing_reference', file: 'app.webmanifest', line: 8 })]);
    expect(w[0].text).toContain('icons/512.png');
  });

  it('checks CSS url() and @import relative to the stylesheet', () => {
    const w = scan({
      'css/site.css': '@import "base.css";\n/* url(gone.png) */\nbody { background: url("../bg.png"); }\n@font-face { src: url(/fonts/a.woff2) format("woff2"); }\n',
      'css/base.css': '',
    });
    expect(w.map((m) => [m.line, m.text.match(/points to (\S+),/)?.[1]])).toEqual([
      [3, 'bg.png'],
      [4, 'fonts/a.woff2'],
    ]);
  });

  it('checks root-absolute fetch() and new URL() paths in scripts and inline scripts', () => {
    const w = scan({
      'src/main.ts': "const a = await fetch('/data/items.json');\nconst u = new URL('/img/x.png', location.href);\n",
      'index.html': page('<script>\nfetch("/inline.json")\n</script>'),
    });
    expect(w.map((m) => [m.file, m.line, m.text.match(/points to (\S+),/)?.[1]])).toEqual([
      ['src/main.ts', 1, 'data/items.json'],
      ['src/main.ts', 2, 'img/x.png'],
      ['index.html', 5, 'inline.json'],
    ]);
  });

  it('ignores computed URLs, other schemes, anchors, routes and extension-less paths', () => {
    const w = scan({
      'index.html': page(
        [
          '<link rel="icon" href="data:image/svg+xml,<svg/>">',
          '<!-- <link rel="icon" href="/commented.ico"> -->',
          '<link rel="canonical" href="/canonical.html">',
        ].join('\n'),
        [
          '<a href="#top">Top</a>',
          '<a href="mailto:a@example.com">Mail</a>',
          '<a href="tel:+420123">Call</a>',
          '<a href="/settings">Settings</a>',
          '<a href="/">Home</a>',
          '<img src="blob:https://x/1">',
          '<img src="{{ logo }}">',
        ].join('\n')
      ),
      'src/main.ts': [
        "fetch('/__drobek/v1/data/notes');",
        'fetch(`/api/${id}.json`);',
        "fetch('/items/' + id + '.json');",
        "fetch(base + '/x.json');",
        "client.fetch('/client.json');",
        "// fetch('/comment.json')",
        "const s = 'fetch(\"/in-string.json\")';",
        "new URL('./rel.png', import.meta.url);",
        "fetch('relative.json');",
      ].join('\n'),
    });
    expect(w).toEqual([]);
  });

  it('reports one warning per missing path and file', () => {
    const w = scan({ 'index.html': page('<img src="/a.png">\n<img src="/a.png">') });
    expect(w).toHaveLength(1);
  });
});

describe('blocked_by_csp', () => {
  it('warns about a fetch() to another origin, naming connect-src and the proxy fix', () => {
    const w = scan({ 'src/api.ts': "export const load = () => fetch('https://api.example.com/v1/items');\n" });
    expect(w).toEqual([expect.objectContaining({ code: 'blocked_by_csp', file: 'src/api.ts', line: 1 })]);
    expect(w[0].text).toContain('connect-src');
    expect(w[0].text).toContain("'self' https://esm.sh");
    expect(w[0].text).toContain('proxy');
  });

  it('warns about fetch(new URL(…)) and window.fetch, not about a URL object alone', () => {
    const w = scan({
      'src/a.js': "window.fetch(\"https://a.example.com/x\");\nfetch(new URL('https://b.example.com/y'));\nconst share = new URL('https://twitter.com/intent/tweet');\n",
    });
    expect(w.map((m) => m.line)).toEqual([1, 2]);
  });

  it('warns about a script from a CDN, a URL import and a non-esm.sh import map entry', () => {
    const w = scan(
      {
        'index.html': page('<script src="https://cdn.example.com/x.js"></script>'),
        'src/main.ts': "import confetti from 'https://cdn.skypack.dev/canvas-confetti';\nconst m = await import('https://unpkg.com/lib@1/x.js');\n",
        'drobek.json': '{\n  "imports": {\n    "react": "https://esm.sh/react@19.1.0",\n    "lodash": "https://cdn.jsdelivr.net/npm/lodash-es@4/lodash.js"\n  }\n}\n',
      },
      { imports: { react: 'https://esm.sh/react@19.1.0', lodash: 'https://cdn.jsdelivr.net/npm/lodash-es@4/lodash.js' } }
    );
    expect(w.map((m) => [m.file, m.line])).toEqual([
      ['index.html', 4],
      ['src/main.ts', 1],
      ['src/main.ts', 2],
      ['drobek.json', 4],
    ]);
    for (const m of w) {
      expect(m.code).toBe('blocked_by_csp');
      expect(m.text).toContain('script-src');
      expect(m.text).toContain('esm.sh');
    }
  });

  it('allows esm.sh scripts, imports and fetches, https images, fonts, stylesheets and media', () => {
    const w = scan(
      {
        'index.html': page(
          [
            '<script type="module" src="https://esm.sh/@tailwindcss/browser@4.1.11"></script>',
            '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&amp;display=swap">',
            '<link rel="preconnect" href="https://fonts.gstatic.com">',
          ].join('\n'),
          [
            '<img src="https://images.example.com/a.jpg">',
            '<video src="https://media.example.com/a.mp4"></video>',
            '<a href="https://example.com/elsewhere">Elsewhere</a>',
          ].join('\n')
        ),
        'src/main.ts': "import x from 'https://esm.sh/x@1';\nfetch('https://esm.sh/y@1/data.json');\n",
        'src/style.css': '@font-face { src: url(https://fonts.gstatic.com/a.woff2); }\nbody { background: url(//cdn.example.com/bg.png); }\n',
        'drobek.json': '{ "imports": { "react": "https://esm.sh/react@19.1.0" } }',
      },
      { imports: { react: 'https://esm.sh/react@19.1.0' } }
    );
    expect(w).toEqual([]);
  });

  it('flags http:// where only https: is allowed, and suggests https', () => {
    const w = scan({ 'index.html': page('', '<img src="http://images.example.com/a.jpg">'), 'a.css': 'b { background: url(http://x.example.com/b.png) }' });
    expect(w.map((m) => [m.file, m.text.includes('img-src'), m.text.includes('https://')])).toEqual([
      ['index.html', true, true],
      ['a.css', true, true],
    ]);
  });
});

describe('compile result', () => {
  it('puts the reference warnings into compile.warnings, never errors', async () => {
    const compiler = new Compiler();
    const r = await compiler.compile(
      new Map([
        ['index.html', page('<link rel="icon" href="/favicon.ico">\n<script type="module" src="/main.js"></script>')],
        ['src/main.ts', "fetch('https://api.example.com/x');\n"],
      ])
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['blocked_by_csp', 'missing_reference']);
  });

  it('warns for a static app too, and takes servedPaths', async () => {
    const compiler = new Compiler();
    const files = new Map([['index.html', page('', '<img src="/hero.jpg">')]]);
    expect((await compiler.compile(files)).warnings.map((w) => w.code)).toEqual(['missing_reference']);
    expect((await compiler.compile(files, { servedPaths: ['hero.jpg'] })).warnings).toEqual([]);
  });
});

describe('hostile input', () => {
  /** 256 KB of `unit`: one file of each took the old regular expressions seconds to minutes. */
  const fill = (unit: string) => unit.repeat(Math.ceil((256 * 1024) / unit.length));
  const ms = (f: () => unknown) => {
    const started = performance.now();
    f();
    return performance.now() - started;
  };

  it.each([
    ['index.html', 'unclosed tags', fill('<a ')],
    ['index.html', 'unclosed tags with values', fill('<a x=y')],
    ['index.html', 'quoted values that each start a tag', `<a${fill(' x="<a z" y=\'<a w\'')}`],
    ['index.html', 'unclosed comments', fill('<!--')],
    ['index.html', 'unclosed scripts', fill('<script>')],
    ['style.css', 'unclosed comments', fill('/* ')],
    ['style.css', 'unclosed url(', fill('url(')],
    ['style.css', 'spaces after url(', `url(${fill(' ')}`],
  ])('scans %s of %s in linear time', (file, _what, text) => {
    expect(ms(() => scan({ [file]: text }))).toBeLessThan(500);
  });

  it('reads the tags after a broken one and the urls after a broken url(', () => {
    const w = scan({
      'index.html': page('', '<div class="a"title="b">\n<img src="/one.png">'),
      'a.css': 'a { background: url(x(1).png) }\nb { background: url( "/two.png" ) }',
    });
    expect(w.map((m) => [m.file, m.line, m.text.match(/points to (\S+),/)?.[1]])).toEqual([
      ['index.html', 8, 'one.png'],
      ['a.css', 2, 'two.png'],
    ]);
  });
});
