import { describe, expect, it } from 'vitest';
import { missingTitle } from './missing-title.js';

const run = (html: string | Buffer | undefined) =>
  missingTitle.run({ files: new Map(html === undefined ? [] : [['index.html', html]]), modules: [] });

describe('missing-title check', () => {
  it('passes an index.html with a title', () => {
    expect(run('<!doctype html><html><head><meta charset="utf-8"><title>Směny</title></head><body></body></html>')).toEqual([]);
  });

  it('passes a title with attributes and surrounding whitespace', () => {
    expect(run('<head>\n  <TITLE data-x="1">\n  Shifts \n</TITLE>\n</head>')).toEqual([]);
  });

  it('reports a missing title at the <head> line', () => {
    expect(run('<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body></body>\n</html>')).toEqual([
      {
        code: 'missing_title',
        file: 'index.html',
        line: 3,
        message: 'index.html has no <title>: browser tabs, bookmarks and shared links show the bare address.',
      },
    ]);
  });

  it('reports an empty title at its own line', () => {
    const [f] = run('<html>\n<head>\n<title>  </title>\n</head></html>') as { line?: number; message: string }[];
    expect(f.line).toBe(3);
    expect(f.message).toContain('empty <title>');
  });

  it('ignores a title in a comment and an inline SVG title in the body', () => {
    const html = '<html><head><!-- <title>Old</title> --></head><body><svg><title>Icon</title></svg></body></html>';
    expect(run(html)).toHaveLength(1);
  });

  it('keeps line numbers across a multi-line comment', () => {
    const [f] = run('<!--\n\n-->\n<head>\n</head>') as { line?: number }[];
    expect(f.line).toBe(4);
  });

  it('says nothing when there is no index.html (or it is not text)', () => {
    expect(run(undefined)).toEqual([]);
    expect(run(Buffer.from('<head></head>'))).toEqual([]);
  });
});
