import { describe, expect, it } from 'vitest';
import { htmlBasics } from './html-basics.js';

type Finding = { code: string; file?: string; line?: number; message: string };

const run = (files: Record<string, string | Buffer>) => htmlBasics.run({ files: new Map(Object.entries(files)), modules: [] }) as Finding[];
const check = (html: string) => run({ 'index.html': html });
const codes = (html: string) => check(html).map((finding) => finding.code);

/** 512 KB (the largest file a version may hold) of `unit`. */
const fill = (unit: string): string => unit.repeat(Math.ceil((512 * 1024) / unit.length)).slice(0, 512 * 1024);

/** The CPU time `f` takes, in ms: other load on the machine does not count. */
function ms(f: () => unknown): number {
  const started = process.cpuUsage();
  f();
  const { user, system } = process.cpuUsage(started);
  return (user + system) / 1000;
}

describe('html-basics check: html_missing_lang', () => {
  it('warns when the html element has no lang and accepts a non-empty lang', () => {
    expect(codes('<html><head><meta name="viewport" content="width=device-width"></head></html>')).toEqual(['html_missing_lang']);
    expect(codes('<html lang=""><head></head></html>')).toContain('html_missing_lang');
    expect(codes('<html lang="en"><head></head></html>')).not.toContain('html_missing_lang');
    expect(codes('<HTML LANG=cs><head></head></HTML>')).not.toContain('html_missing_lang');
  });

  it('reports the <html> line, or line 1 of a document without an <html> tag', () => {
    expect(check('<!doctype html>\n<html>\n<head></head>\n</html>').find((f) => f.code === 'html_missing_lang')).toEqual({
      code: 'html_missing_lang',
      file: 'index.html',
      line: 2,
      message:
        'index.html has no lang on its <html> element: screen readers read the page in the wrong language and browsers cannot offer a translation.',
    });
    expect(check('<!doctype html>\n<head><title>T</title></head>').find((f) => f.code === 'html_missing_lang')?.line).toBe(1);
  });
});

describe('html-basics check: html_missing_viewport', () => {
  it('warns when the viewport meta is missing or has no content and accepts a case-insensitive name', () => {
    expect(codes('<html lang="en"><head></head></html>')).toEqual(['html_missing_viewport']);
    expect(codes('<html lang="en"><head><meta name="viewport"></head></html>')).toEqual(['html_missing_viewport']);
    expect(codes('<html lang="en"><meta NAME="Viewport" CONTENT="width=device-width"></html>')).toEqual([]);
    expect(codes('<html lang="en"><meta name="description" content="x"><meta name="viewport" content="width=device-width, initial-scale=1"></html>')).toEqual([]);
  });

  it('reports the <head> line, or the line of an empty viewport meta', () => {
    const [missing] = check('<!doctype html>\n<html lang="en">\n<head>\n</head>\n</html>');
    expect(missing).toMatchObject({ code: 'html_missing_viewport', file: 'index.html', line: 3 });
    expect(missing.message).toContain('index.html has no <meta name="viewport">');
    const [empty] = check('<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content=" ">\n</head>\n</html>');
    expect(empty).toMatchObject({ code: 'html_missing_viewport', line: 4 });
    expect(empty.message).toContain('an empty <meta name="viewport">');
  });
});

describe('html-basics check: page rules run on full documents only', () => {
  it('leaves a fragment without <html> or <head> alone, and still checks its elements', () => {
    expect(codes('<section><h2>Partial</h2><p>No document here.</p></section>')).toEqual([]);
    expect(codes('<section><img src="a.png"></section>')).toEqual(['a11y_img_alt']);
  });

  it('checks every .html file of the version, not only index.html, and no other file', () => {
    const files = {
      'index.html': '<html lang="en"><head><meta name="viewport" content="width=device-width"></head></html>',
      'about/Team.HTML': '<html><head></head><body><img src="team.jpg"></body></html>',
      'partials/card.html': '<div class="card"><button></button></div>',
      'src/main.tsx': '<html><img><button></button><input>',
      'logo.svg': '<svg><a href="#"></a></svg>',
      'photo.html': Buffer.from('<html><img></html>'),
    };
    expect(run(files).map((f) => `${f.code} ${f.file}`)).toEqual([
      'html_missing_lang about/Team.HTML',
      'html_missing_viewport about/Team.HTML',
      'a11y_img_alt about/Team.HTML',
      'a11y_name partials/card.html',
    ]);
  });
});

describe('html-basics check: a11y_img_alt', () => {
  it('warns for images without alt and accepts alt="" and a bare alt', () => {
    expect(codes('<img src="photo.png">')).toEqual(['a11y_img_alt']);
    expect(codes('<img src="divider.png" alt="">')).toEqual([]);
    expect(codes('<img src="divider.png" alt>')).toEqual([]);
    expect(codes('<img src="photo.png" alt="A mountain">')).toEqual([]);
  });

  it('accepts an image named or hidden another way, and an alt bound by a template', () => {
    for (const img of [
      '<img src="a.png" aria-label="A mountain">',
      '<img src="a.png" aria-labelledby="caption">',
      '<img src="a.png" role="presentation">',
      '<img src="a.png" role="none">',
      '<img src="a.png" aria-hidden="true">',
      '<img :src="photo.url" :alt="photo.title">',
      '<img v-bind:alt="photo.title">',
      '<img x-bind:alt="photo.title">',
    ]) {
      expect(codes(img), img).toEqual([]);
    }
  });

  it('names the image by its src, cut when long', () => {
    expect(check('<p>\n<img src="/img/team.jpg" class="wide">\n</p>')).toEqual([
      {
        code: 'a11y_img_alt',
        file: 'index.html',
        line: 2,
        message: '<img src="/img/team.jpg"> has no alt attribute: a screen reader reads out the file name instead of what the image shows.',
      },
    ]);
    const [long] = check(`<img src="data:image/png;base64,${'A'.repeat(500)}">`);
    expect(long.message.length).toBeLessThan(200);
    expect(long.message).toContain('…"> has no alt attribute');
  });

  it('does not read comments, scripts, templates or textareas as markup', () => {
    expect(codes('<!-- <img src="old.png"> --><script>const html = "<img><button></button><input>";</script>')).toEqual([]);
    expect(codes('<template><img><button></button><input></template><textarea aria-label="Code"><img><input></textarea>')).toEqual([]);
  });
});

describe('html-basics check: a11y_name', () => {
  it('warns for unnamed buttons and links', () => {
    expect(codes('<button></button><a href="/next"></a>')).toEqual(['a11y_name', 'a11y_name']);
    expect(codes('<button>  &nbsp;&#160; \n</button>')).toEqual(['a11y_name']);
    expect(codes('<button><svg viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg></button>')).toEqual(['a11y_name']);
    expect(codes('<a href="/cart"><i class="icon-cart"></i></a>')).toEqual(['a11y_name']);
    expect(codes('<a href="/home"><img src="logo.png" alt=""></a>')).toEqual(['a11y_name']);
  });

  it('accepts every way a button or a link gets its name', () => {
    for (const named of [
      '<button>Save</button>',
      '<button type="submit"><span class="label">Save</span></button>',
      '<button>&times;</button>',
      '<button>2 < 3</button>',
      '<button aria-label="Save"></button>',
      '<button aria-labelledby="save-label"></button>',
      '<button title="Save"></button>',
      '<button><img src="save.png" alt="Save"></button>',
      '<button><svg aria-label="Close"><path d="M0 0"/></svg></button>',
      '<button><svg><title>Close</title><path d="M0 0"/></svg></button>',
      '<button><span class="sr-only">Close</span><svg aria-hidden="true"></svg></button>',
      '<BUTTON>Save</BUTTON>',
      '<a href="/next">Continue</a>',
      '<a href="/next" aria-label="Continue"></a>',
      '<a href="/next" aria-labelledby="continue-label"></a>',
      '<a href="/next" title="Continue"></a>',
      '<a href="/next"><img alt="Continue"></a>',
      '<a href="/next">{{ label }}</a>',
    ]) {
      expect(codes(named), named).toEqual([]);
    }
  });

  it('leaves alone an anchor without href, a hidden control and one a template names in the browser', () => {
    for (const skipped of [
      '<a>Not a link</a>',
      '<a name="top"></a>',
      '<button aria-hidden="true" tabindex="-1"></button>',
      '<button x-text="label"></button>',
      '<button v-text="label"></button>',
      '<button :aria-label="label"></button>',
      '<button><span x-text="count"></span></button>',
      '<a-scene></a-scene><button-group></button-group>',
    ]) {
      expect(codes(skipped), skipped).toEqual([]);
    }
  });

  it('leaves an element without its end tag alone', () => {
    expect(codes('<button><p>no end tag')).toEqual([]);
    expect(codes('<a href="/x">')).toEqual([]);
  });

  it('names the element and what a screen reader announces', () => {
    expect(check('<nav>\n<a href="/cart" id="cart"><i class="icon"></i></a>\n<button id="menu"></button>\n</nav>')).toEqual([
      {
        code: 'a11y_name',
        file: 'index.html',
        line: 2,
        message:
          '<a href="/cart" id="cart"> has no accessible name (no text, aria-label or title, and no image with alt text inside): a screen reader announces only "link".',
      },
      {
        code: 'a11y_name',
        file: 'index.html',
        line: 3,
        message:
          '<button id="menu"> has no accessible name (no text, aria-label or title, and no image with alt text inside): a screen reader announces only "button".',
      },
    ]);
  });
});

describe('html-basics check: a11y_label', () => {
  it('warns for unlabelled controls', () => {
    expect(codes('<input><select></select><textarea></textarea>')).toEqual(['a11y_label', 'a11y_label', 'a11y_label']);
    expect(codes('<input type="search" placeholder="Search…">')).toEqual(['a11y_label']);
    expect(codes('<label for="other">Other</label><input id="email">')).toEqual(['a11y_label']);
    expect(codes('<label>Name</label><input id="name">')).toEqual(['a11y_label']);
  });

  it('accepts explicit, wrapping, ARIA and title labels', () => {
    for (const labelled of [
      '<label for="email">Email</label><input id="email">',
      '<input id="email"><label for="email">Email</label>',
      '<label><input></label>',
      '<label>Country <select><option>CZ</option></select></label>',
      '<LABEL>Notes <textarea></textarea></LABEL>',
      '<label><span>Agree</span> <input type="checkbox"></label><label>Name <input></label>',
      '<textarea aria-label="Notes"></textarea>',
      '<input aria-labelledby="name-label">',
      '<input title="Search">',
      '<input :aria-label="field.label">',
      '<input :id="field.id">',
    ]) {
      expect(codes(labelled), labelled).toEqual([]);
    }
  });

  it('exempts hidden, submit, button, reset and image inputs and hidden controls', () => {
    const exempt = ['hidden', 'submit', 'button', 'reset', 'image', 'HIDDEN'].map((type) => `<input type="${type}">`).join('');
    expect(codes(`${exempt}<input type="file" hidden><input aria-hidden="true">`)).toEqual([]);
  });

  it('does not take the label of an earlier control for a later one', () => {
    expect(check('<label>Name <input name="n"></label>\n<input name="after">').map((f) => f.line)).toEqual([2]);
  });

  it('names the control by its type, id and name', () => {
    expect(check('<form>\n<input type="email" name="email" id="email" placeholder="you@example.com">\n</form>')).toEqual([
      {
        code: 'a11y_label',
        file: 'index.html',
        line: 2,
        message:
          '<input type="email" id="email" name="email"> has no label (no <label for>, no <label> around it, no aria-label or aria-labelledby): a screen reader does not say what the field is for. A placeholder is not a label.',
      },
    ]);
  });
});

describe('html-basics check: the whole page', () => {
  it('returns no findings for a clean page', () => {
    const clean = [
      '<!doctype html>',
      '<html lang="en">',
      '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>App</title></head>',
      '<body>',
      '<img src="divider.png" alt=""><img src="team.jpg" alt="The team">',
      '<button>Save</button><a href="/">Home</a>',
      '<label for="q">Query</label><input id="q"><label>Sort <select><option>A–Z</option></select></label>',
      '</body>',
      '</html>',
    ].join('\n');
    expect(check(clean)).toEqual([]);
  });

  it('reports source lines for page and element findings', () => {
    const findings = check('<html>\n<head></head>\n<img>\n<button></button>\n<input>\n</html>');
    expect(findings.map((f) => `${f.code}:${f.line}`)).toEqual([
      'html_missing_lang:1',
      'html_missing_viewport:2',
      'a11y_img_alt:3',
      'a11y_name:4',
      'a11y_label:5',
    ]);
  });

  it('caps each element rule at five findings plus one that counts the rest, at the line of the first one left out', () => {
    const lines = (tag: string) => Array.from({ length: 7 }, () => tag).join('\n');
    const findings = check(`${lines('<img>')}\n${lines('<button></button>')}\n${lines('<input>')}`);
    for (const [code, first, rest] of [
      ['a11y_img_alt', 1, 'index.html has 2 more images without an alt attribute.'],
      ['a11y_name', 8, 'index.html has 2 more buttons or links without an accessible name.'],
      ['a11y_label', 15, 'index.html has 2 more form fields without a label.'],
    ] as const) {
      const family = findings.filter((f) => f.code === code);
      expect(family.map((f) => f.line), code).toEqual([first, first + 1, first + 2, first + 3, first + 4, first + 5]);
      expect(family[5].message).toBe(rest);
    }
    expect(check(Array.from({ length: 5 }, () => '<img>').join('\n'))).toHaveLength(5);
  });
});

describe('html-basics check: linear time on hostile input (512 KB)', () => {
  it.each([
    ['start tags without >', '<a '],
    ['unclosed elements', '<div>x'],
    ['unclosed buttons', '<button>x'],
    ['unclosed links', '<a href="/x">'],
    ['unclosed labels', '<label><input>'],
    ['unclosed quotes', '<a title="'],
    ['unclosed comments', '<!--<img>'],
    ['stray end tags', '</span></a></label>'],
    ['unnamed buttons', '<button></button>'],
    ['unlabelled inputs in labels', '<label>x</label><input>'],
    ['bare ampersands', '<button>&#</button>'],
  ])('%s', (_name, unit) => {
    const html = fill(unit);
    expect(ms(() => check(html))).toBeLessThan(1000);
    expect(ms(() => check(`<html><head>${html}`))).toBeLessThan(1000);
  });
});
