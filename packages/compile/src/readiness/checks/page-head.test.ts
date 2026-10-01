import { describe, expect, it } from 'vitest';
import { pageHead } from './page-head.js';

type Finding = { code: string; file?: string; line?: number; message: string };

const run = (files: Record<string, string | Buffer>) => pageHead.run({ files: new Map(Object.entries(files)), modules: [] }) as Finding[];
const codes = (files: Record<string, string | Buffer>) => run(files).map((f) => f.code);

const DESCRIPTION = '<meta name="description" content="Splits a restaurant bill between friends.">';
const ICON = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
const page = (head: string, body = '<h1>Tips</h1>') =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Tips</title>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

describe('page-head check: missing_description', () => {
  it('passes a non-empty description in the head', () => {
    expect(codes({ 'index.html': page(`${DESCRIPTION}\n${ICON}`) })).toEqual([]);
    expect(codes({ 'index.html': page(`<META NAME="Description" CONTENT='Tips.'>\n${ICON}`) })).toEqual([]);
  });

  it('reports a missing description at the <head> line', () => {
    expect(run({ 'index.html': page(ICON) })).toEqual([
      {
        code: 'missing_description',
        file: 'index.html',
        line: 3,
        message:
          'index.html has no <meta name="description">: search results and link previews show text picked from the page, or none, instead of a sentence about what the app does.',
      },
    ]);
  });

  it('reports an empty description at its own line', () => {
    const [f] = run({ 'index.html': page(`${ICON}\n<meta name="description" content="   ">`) });
    expect(f).toMatchObject({ code: 'missing_description', line: 7 });
    expect(f.message).toContain('an empty <meta name="description">');
    expect(codes({ 'index.html': page(`${ICON}\n<meta name="description">`) })).toEqual(['missing_description']);
  });

  it('ignores a description in a comment, in a script and in the body', () => {
    expect(codes({ 'index.html': page(`${ICON}\n<!-- ${DESCRIPTION} -->`) })).toEqual(['missing_description']);
    expect(codes({ 'index.html': page(`${ICON}\n<script>const m = '${DESCRIPTION}';</script>`) })).toEqual(['missing_description']);
    expect(codes({ 'index.html': page(ICON, DESCRIPTION) })).toEqual(['missing_description']);
  });

  it('does not take og:description or a property="description" for the description', () => {
    expect(codes({ 'index.html': page(`${ICON}\n<meta property="og:description" content="Tips.">`) })).toEqual(['missing_description']);
    expect(codes({ 'index.html': page(`${ICON}\n<meta property="description" content="Tips.">`) })).toEqual(['missing_description']);
  });

  it('reads a page without <head> or <body> tags as all head', () => {
    expect(codes({ 'index.html': `<!doctype html><title>Tips</title>${DESCRIPTION}${ICON}<h1>Tips</h1>` })).toEqual([]);
  });
});

describe('page-head check: missing_favicon', () => {
  it('passes any link whose rel has the icon token and an href', () => {
    for (const link of [ICON, '<link rel="shortcut icon" href="/favicon.ico">', '<link href="/i.png" rel="ICON">', '<link rel=icon href=/f.svg>']) {
      expect(codes({ 'index.html': page(`${DESCRIPTION}\n${link}`) }), link).toEqual([]);
    }
  });

  it('passes a version with a favicon.ico file at its root', () => {
    expect(codes({ 'index.html': page(DESCRIPTION), 'favicon.ico': Buffer.from([0, 0, 1, 0]) })).toEqual([]);
  });

  it('reports no icon at the <head> line and says an uploaded favicon.ico must be linked', () => {
    const [f] = run({ 'index.html': page(DESCRIPTION) });
    expect(f).toMatchObject({ code: 'missing_favicon', file: 'index.html', line: 3 });
    expect(f.message).toContain('index.html has no <link rel="icon"> and the version has no favicon.ico');
    expect(f.message).toContain('An uploaded favicon.ico counts only when index.html links it with <link rel="icon" href="/favicon.ico">.');
  });

  it('an apple-touch-icon, a mask-icon, an icon without href, one in a comment or in the body is not a favicon', () => {
    for (const head of [
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
      '<link rel="mask-icon" href="/mask.svg">',
      '<link rel="icon">',
      '<link rel="icon" href="">',
      `<!-- ${ICON} -->`,
      '<link rel="manifest" href="/manifest.webmanifest">',
    ]) {
      expect(codes({ 'index.html': page(`${DESCRIPTION}\n${head}`) }), head).toEqual(['missing_favicon']);
    }
    expect(codes({ 'index.html': page(DESCRIPTION, ICON) })).toEqual(['missing_favicon']);
    expect(codes({ 'index.html': page(DESCRIPTION), 'img/favicon.ico': Buffer.from([0]) })).toEqual(['missing_favicon']);
  });

  it('reports both for a bare page, in head order', () => {
    expect(codes({ 'index.html': '<html><head></head><body></body></html>' })).toEqual(['missing_description', 'missing_favicon']);
  });
});

describe('page-head check: og_image_not_absolute', () => {
  const withMeta = (meta: string) => ({ 'index.html': page(`${DESCRIPTION}\n${ICON}\n${meta}`) });

  it('passes an absolute https image', () => {
    expect(codes(withMeta('<meta property="og:image" content="https://tips.apps.example.com/og.png">'))).toEqual([]);
    expect(codes(withMeta('<meta name="twitter:image" content="HTTPS://cdn.example.com/a.jpg?v=2">'))).toEqual([]);
  });

  it('reports a root-relative path with the meta, the value and the line', () => {
    expect(run(withMeta('<meta property="og:image" content="/og.png">'))).toEqual([
      {
        code: 'og_image_not_absolute',
        file: 'index.html',
        line: 8,
        message:
          '<meta property="og:image"> is "/og.png", not an absolute https:// URL: social networks and chat apps load the preview image from the URL exactly as written, so the shared link shows no image.',
      },
    ]);
  });

  it('reports protocol-relative, relative, http, data: and empty values of every image key', () => {
    const metas = [
      '<meta property="og:image" content="//tips.apps.example.com/og.png">',
      '<meta property="og:image:url" content="og.png">',
      '<meta property="og:image:secure_url" content="http://tips.apps.example.com/og.png">',
      '<meta name="twitter:image" content="data:image/png;base64,iVBORw0KGgo=">',
      '<meta name="twitter:image:src" content="https://">',
      '<meta property="og:image" content="">',
    ];
    const found = run(withMeta(metas.join('\n')));
    expect(found.map((f) => `${f.code}:${f.line}`)).toEqual(metas.map((_, i) => `og_image_not_absolute:${8 + i}`));
    expect(found[3].message).toContain('<meta name="twitter:image"> is "data:image/png;base64,iVBORw0KGgo=", not an absolute https:// URL');
    expect(found[5].message).toContain('<meta property="og:image"> has no URL:');
  });

  it('quotes at most 80 characters of a long value', () => {
    const [f] = run(withMeta(`<meta property="og:image" content="/${'a'.repeat(200)}.png">`));
    expect(f.message).toContain(`"/${'a'.repeat(79)}…"`);
  });

  it('checks every HTML page, not other meta keys or commented-out tags', () => {
    expect(codes({ ...withMeta('<!-- <meta property="og:image" content="/og.png"> -->'), 'about.html': '<meta property="og:image" content="/about.png">' })).toEqual([
      'og_image_not_absolute',
    ]);
    expect(run({ 'about.html': '<meta property="og:image" content="/about.png">' })[0].file).toBe('about.html');
    expect(codes(withMeta('<meta property="og:title" content="/og.png"><meta property="og:url" content="/">'))).toEqual([]);
  });
});

describe('page-head check: no index.html', () => {
  it('says nothing about the description or favicon when there is no index.html (or it is not text)', () => {
    expect(codes({})).toEqual([]);
    expect(codes({ 'index.html': Buffer.from('<head></head>') })).toEqual([]);
    expect(codes({ 'about.html': '<head></head>' })).toEqual([]);
  });
});
