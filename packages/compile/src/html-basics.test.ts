import { describe, expect, it } from 'vitest';
import { checkHtmlBasics } from './html-basics.js';

const check = (html: string, files: ReadonlySet<string> = new Set()) =>
  checkHtmlBasics('index.html', html, files);

const codes = (html: string, files?: ReadonlySet<string>) => check(html, files).map((warning) => warning.code);

describe('checkHtmlBasics', () => {
  it('warns when the html element has no lang and accepts a non-empty lang', () => {
    expect(codes('<html><head></head></html>')).toContain('html_missing_lang');
    expect(codes('<html lang=""><head></head></html>')).toContain('html_missing_lang');
    expect(codes('<html lang="en"><head></head></html>')).not.toContain('html_missing_lang');
  });

  it('warns when the viewport meta is missing and accepts a case-insensitive name', () => {
    expect(codes('<html></html>')).toContain('html_missing_viewport');
    expect(codes('<meta NAME="Viewport">')).not.toContain('html_missing_viewport');
    expect(codes('<meta name="description"><meta name="viewport">')).not.toContain('html_missing_viewport');
  });

  it('warns for a missing or empty title, but accepts title text', () => {
    expect(codes('<html></html>')).toContain('html_missing_title');
    expect(codes('<title> \n </title>')).toContain('html_missing_title');
    expect(codes('<title>Workspace</title>')).not.toContain('html_missing_title');
  });

  it('accepts an icon link or favicon file and otherwise warns once', () => {
    expect(codes('<html></html>').filter((code) => code === 'missing_favicon')).toHaveLength(1);
    expect(codes('<link rel="shortcut icon" href="/icon.ico">')).not.toContain('missing_favicon');
    expect(codes('<html></html>', new Set(['favicon.ico']))).not.toContain('missing_favicon');
    expect(codes('<html></html>', new Set(['assets/favicon.svg']))).not.toContain('missing_favicon');
  });

  it('warns for images without alt and accepts alt=""', () => {
    expect(codes('<img src="photo.png">')).toContain('a11y_img_alt');
    expect(codes('<img src="divider.png" alt="">')).not.toContain('a11y_img_alt');
    expect(codes('<img src="photo.png" alt="A mountain">')).not.toContain('a11y_img_alt');
  });

  it('warns for unnamed buttons and linked anchors, and accepts supported names', () => {
    expect(codes('<button></button><a href="/next"></a>').filter((code) => code === 'a11y_name')).toHaveLength(2);
    const named = [
      '<button>Save</button>',
      '<button aria-label="Save"></button>',
      '<button aria-labelledby="save-label"></button>',
      '<button title="Save"></button>',
      '<button><img alt="Save"></button>',
      '<a href="/next">Continue</a>',
      '<a href="/next" aria-label="Continue"></a>',
      '<a href="/next" aria-labelledby="continue-label"></a>',
      '<a href="/next" title="Continue"></a>',
      '<a href="/next"><img alt="Continue"></a>',
    ].join('');
    expect(codes(named)).not.toContain('a11y_name');
    expect(codes('<a>Not a link</a>')).not.toContain('a11y_name');
  });

  it('warns for unlabelled controls and accepts explicit, wrapping, and ARIA labels', () => {
    expect(codes('<input><select></select><textarea></textarea>').filter((code) => code === 'a11y_label')).toHaveLength(3);
    const labelled = [
      '<label for="email">Email</label><input id="email">',
      '<label><input></label>',
      '<label><select></select></label>',
      '<textarea aria-label="Notes"></textarea>',
      '<input aria-labelledby="name-label">',
    ].join('');
    expect(codes(labelled)).not.toContain('a11y_label');
    expect(codes('<label for="other">Other</label><input id="email">')).toContain('a11y_label');
  });

  it('exempts hidden, submit, button, and reset inputs', () => {
    const html = ['hidden', 'submit', 'button', 'reset'].map((type) => `<input type="${type}">`).join('');
    expect(codes(html)).not.toContain('a11y_label');
  });

  it('returns no warnings for a clean page and ignores non-HTML files', () => {
    const clean = '<html lang="en"><head><meta name="viewport"><title>App</title><link rel="icon"></head><body><img alt=""><button>Save</button><a href="/">Home</a><label for="q">Query</label><input id="q"></body></html>';
    expect(check(clean)).toEqual([]);
    expect(checkHtmlBasics('main.tsx', '<img><button></button>', new Set())).toEqual([]);
  });

  it('does not parse script contents or literal less-than text as markup', () => {
    expect(codes('<button>2 < 3</button><script><img><button></button></script>')).not.toContain('a11y_name');
    expect(codes('<script><img></script>')).not.toContain('a11y_img_alt');
  });

  it('reports source lines for element and html warnings', () => {
    const warnings = check('<html>\n<img>\n<button></button>\n</html>');
    expect(warnings.find((warning) => warning.code === 'html_missing_lang')?.line).toBe(1);
    expect(warnings.find((warning) => warning.code === 'a11y_img_alt')?.line).toBe(2);
    expect(warnings.find((warning) => warning.code === 'a11y_name')?.line).toBe(3);
  });

  it('caps each element warning family at five plus one summary', () => {
    const warnings = check(`<html>${'<img>'.repeat(7)}${'<button></button>'.repeat(7)}${'<input>'.repeat(7)}</html>`);
    for (const code of ['a11y_img_alt', 'a11y_name', 'a11y_label']) {
      const family = warnings.filter((warning) => warning.code === code);
      expect(family).toHaveLength(6);
      expect(family.slice(0, 5).every((warning) => warning.line === 1)).toBe(true);
      expect(family[5].text).toContain('2 more');
    }
  });
});