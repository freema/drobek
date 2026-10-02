import { describe, expect, it } from 'vitest';
import { DEFAULT_ABUSE_BRAND_WORDS, brandWordsFromEnv, describeFinding, scanForPhishing } from './heuristic.js';
import { normalizeReportHost, termsUrl, reportFormUrl, lockedMessage, lockCategory } from './moderation.js';

const words = brandWordsFromEnv({});

/** What esbuild emits for a small React login form (automatic JSX runtime). */
const BANK_LOGIN_JS = `import { jsx, jsxs } from "https://esm.sh/react@19.1.0/jsx-runtime";
function App() {
  return /* @__PURE__ */ jsxs("form", { children: [
    /* @__PURE__ */ jsx("h1", { children: "Bank login" }),
    /* @__PURE__ */ jsx("input", { name: "user", placeholder: "Client number" }),
    /* @__PURE__ */ jsx("input", { name: "pass", type: "password" }),
    /* @__PURE__ */ jsx("button", { children: "Sign in" })
  ] });
}`;

const INDEX = (title: string) =>
  `<!doctype html><html><head><title>${title}</title><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>`;

const CALCULATOR_JS = `import { jsx, jsxs } from "https://esm.sh/react@19.1.0/jsx-runtime";
function Calc() {
  return /* @__PURE__ */ jsxs("main", { children: [
    /* @__PURE__ */ jsx("h1", { children: "Calculator" }),
    /* @__PURE__ */ jsx("input", { type: "number", value: a }),
    /* @__PURE__ */ jsx("button", { children: "=" })
  ] });
}`;

describe('publish heuristic', () => {
  it('flags a test "bank login" app: password field + brand word', () => {
    const f = scanForPhishing(
      [
        { path: 'index.html', content: INDEX('Bank login') },
        { path: 'main.js', content: BANK_LOGIN_JS },
      ],
      words
    );
    expect(f.flagged).toBe(true);
    expect(f.passwordIn).toEqual(['main.js']);
    expect(f.brands.map((b) => b.word)).toContain('bank');
    expect(f.brands.find((b) => b.word === 'bank')?.where).toBe('title');
    expect(describeFinding(f, 3)).toMatch(/version 3.*password field \(main\.js\).*"bank" \(title\)/);
  });

  it('does not flag a calculator (no password field)', () => {
    const f = scanForPhishing(
      [
        { path: 'index.html', content: INDEX('Calculator') },
        { path: 'main.js', content: CALCULATOR_JS },
      ],
      words
    );
    expect(f.flagged).toBe(false);
    expect(f.passwordIn).toEqual([]);
  });

  it('does not flag a password form without a brand word (a normal app login)', () => {
    const f = scanForPhishing(
      [{ path: 'index.html', content: `<title>Team notes</title><form><input type="password" name="p"></form>` }],
      words
    );
    expect(f.passwordIn).toEqual(['index.html']);
    expect(f.brands).toEqual([]);
    expect(f.flagged).toBe(false);
  });

  it('does not flag a brand mention without a password field', () => {
    const f = scanForPhishing([{ path: 'index.html', content: `<title>My PayPal budget tracker</title><h1>PayPal</h1>` }], words);
    expect(f.brands.map((b) => b.word)).toEqual(['paypal']);
    expect(f.flagged).toBe(false);
  });

  it('finds plain-HTML phishing: <input type=password>, brand in <h1>, diacritics and case folded', () => {
    const f = scanForPhishing(
      [
        {
          path: 'index.html',
          content: `<title>Přihlášení</title><h1>ČESKÁ SPOŘITELNA</h1><form><input name=u><input type=password name=p></form>`,
        },
      ],
      words
    );
    expect(f.flagged).toBe(true);
    expect(f.brands).toEqual([{ word: 'ceska sporitelna', where: 'h1' }]);
  });

  it('matches whole words / phrases only and ignores URLs and domain names', () => {
    const f = scanForPhishing(
      [
        {
          path: 'index.html',
          content: `<title>Banksy gallery</title><p>Fonts from fonts.googleapis.com and https://www.google.com/maps</p><input type="password">`,
        },
      ],
      words
    );
    expect(f.brands).toEqual([]);
    expect(f.flagged).toBe(false);
  });

  it('detects password fields built in JS: setAttribute and markup strings', () => {
    const a = scanForPhishing([{ path: 'app.js', content: `el.setAttribute("type", "password"); document.title = "PayPal";` }], words);
    expect(a.flagged).toBe(true);
    const b = scanForPhishing([{ path: 'app.mjs', content: 'root.innerHTML = `<h1>Netflix</h1><input type="password">`;' }], words);
    expect(b.flagged).toBe(true);
    const c = scanForPhishing([{ path: 'index.html', content: `<script>document.body.innerHTML = '<input type=\\'password\\'>'; const t = "Microsoft";</script>` }], words);
    expect(c.flagged).toBe(true);
  });

  it('ABUSE_BRAND_WORDS replaces the default list (normalized); unset/empty → defaults', () => {
    expect(brandWordsFromEnv({ ABUSE_BRAND_WORDS: ' Acme Bank , ŽIVNO,x ' })).toEqual(['acme bank', 'zivno']);
    expect(brandWordsFromEnv({ ABUSE_BRAND_WORDS: '' })).toEqual(brandWordsFromEnv({}));
    expect(brandWordsFromEnv({}).length).toBe(DEFAULT_ABUSE_BRAND_WORDS.length);
    const custom = brandWordsFromEnv({ ABUSE_BRAND_WORDS: 'acme bank' });
    const f = scanForPhishing([{ path: 'index.html', content: '<title>Bank login</title><input type="password">' }], custom);
    expect(f.flagged).toBe(false);
  });
});

describe('publish heuristic: hostile input', () => {
  /** 512 KB, the largest file a version may hold. */
  const fill = (unit: string) => unit.repeat(Math.ceil((512 * 1024) / unit.length)).slice(0, 512 * 1024);
  const ms = (f: () => unknown) => {
    const started = performance.now();
    f();
    return performance.now() - started;
  };

  it.each([
    ['unclosed tags', '<'],
    ['unclosed tags with attributes', '<a x=y '],
    ['unclosed inputs', '<input '],
    ['unclosed titles', '<title>'],
    ['title start tags without >', '<title'],
    ['unclosed headings', '<h1>'],
    ['unclosed scripts', '<script>'],
    ['unclosed styles', '<style'],
    ['unclosed comments', '<!--'],
    ['one long dotted name', 'a.'],
    ['one long hyphenated name', 'a-'],
  ])('scans 512 KB of %s in linear time', (_what, unit) => {
    const content = fill(unit);
    expect(ms(() => scanForPhishing([{ path: 'index.html', content }], words))).toBeLessThan(500);
  });

  it.each([
    ['short strings', '"a"'],
    ['short templates', '`a`'],
    ['one long dotted name', 'a.'],
  ])('scans a 512 KB script of %s in linear time', (_what, unit) => {
    const content = fill(unit);
    expect(ms(() => scanForPhishing([{ path: 'main.js', content }, { path: 'index.html', content: `<script>${content}</script>` }], words))).toBeLessThan(500);
  });

  it('reads the title, the visible text and a password input next to broken markup', () => {
    const f = scanForPhishing(
      [{ path: 'index.html', content: "<title>PayPal</title><!-- x --><p>Log in to <i>Revolut</i></p><input name=p\n type = 'password'><h1>Sign in<style" }],
      words
    );
    expect(f).toEqual({
      flagged: true,
      passwordIn: ['index.html'],
      brands: [
        { word: 'paypal', where: 'title' },
        { word: 'revolut', where: 'text' },
      ],
    });
  });

  it('still ignores domain names wherever they stand', () => {
    const content = '<p>see...paypal.com, mail.google.com. (netflix.co.uk) x-amazon.de/a "Microsoft.com" -apple.io</p><input type=password>';
    expect(scanForPhishing([{ path: 'index.html', content }], words).brands).toEqual([]);
  });

  it('reads a domain glued to a leading _ as words', () => {
    const content = '<p>sign_-paypal.com</p><input type=password>';
    expect(scanForPhishing([{ path: 'index.html', content }], words).brands).toEqual([{ word: 'paypal', where: 'text' }]);
  });
});

describe('publish heuristic: well-formed pages (seeded fuzz against the regular expressions it used before)', () => {
  function previousScan(files: { path: string; content: string }[]): ReturnType<typeof scanForPhishing> {
    const normalize = (t: string) => t.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    const safe = (c: number) => (Number.isInteger(c) && c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ' ');
    const decode = (t: string) =>
      t
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d{1,7});/g, (_, d: string) => safe(Number(d)))
        .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safe(parseInt(h, 16)));
    const stripTags = (t: string) => decode(t.replace(/<[^>]*>/g, ' '));
    const jsPassword = (js: string) =>
      [/\btype\s*:\s*["'`]password["'`]/i, /\btype\s*=\s*\\?["'`]?password\b/i, /["'`]type["'`]\s*,\s*["'`]password["'`]/i].some((re) => re.test(js));
    const jsStrings = (js: string) =>
      [...js.matchAll(/"((?:[^"\\\n]|\\.){1,500})"|'((?:[^'\\\n]|\\.){1,500})'|`((?:[^`\\]|\\.){1,2000})`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
    const passwordIn: string[] = [];
    const texts = { title: [] as string[], h1: [] as string[], text: [] as string[], js: [] as string[] };
    for (const f of files) {
      if (f.path.endsWith('.html')) {
        const html = f.content;
        let password = /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html);
        texts.title.push(...[...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => stripTags(m[1])));
        texts.h1.push(...[...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripTags(m[1])));
        for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
          if (jsPassword(m[1])) password = true;
          texts.js.push(...jsStrings(m[1]));
        }
        texts.text.push(stripTags(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')));
        if (password) passwordIn.push(f.path);
      } else {
        if (jsPassword(f.content)) passwordIn.push(f.path);
        texts.js.push(...jsStrings(f.content));
      }
    }
    const strip = (t: string) =>
      t.replace(/(?:https?:)?\/\/[^\s"'`<>)]+/gi, ' ').replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|app|dev|cz|sk|eu|co|us|uk|de)\b/gi, ' ');
    const hay = Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, ` ${normalize(strip(v.join('\n')))} `]));
    const brands = words.flatMap((word) => {
      const where = (['title', 'h1', 'text', 'js'] as const).find((w) => hay[w].includes(` ${word} `));
      return where ? [{ word, where }] : [];
    });
    return { flagged: passwordIn.length > 0 && brands.length > 0, passwordIn, brands };
  }

  it('finds what the regular expressions found on 2,000 generated pages', () => {
    let seed = 87;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
    const some = (list: readonly string[], max: number) => Array.from({ length: Math.floor(rnd() * (max + 1)) }, () => pick(list)).join(' ');
    const prose = ['Sign in', 'PayPal', 'Revolut', 'apple id', 'Bank', 'shifts', 'paypal.com', 'mail.google.com', 'x-amazon.de/a', 'https://netflix.com/a', '&amp;', '&#80;ayPal', 'Wells&nbsp;Fargo', '3 > 2', '\n', 'é', 'Česká spořitelna'];
    const script = ['const t = "Log in to PayPal";', "el.type = 'password';", 'jsx("input", { type: "password" })', "'<input type=\"password\">'", 'x = `Revolut ${n}`;', 'if (a < b) go();'];
    for (let i = 0; i < 2000; i++) {
      const nodes: string[] = [];
      for (let n = Math.floor(rnd() * 14); n > 0; n--) {
        const text = some(prose, 4);
        nodes.push(
          pick([
            `<title>${text}</title>`,
            `<TITLE lang=en>${text}</TITLE>`,
            `<h1 class="x">${text}<b>${pick(prose)}</b></h1>`,
            `<p>${text}</p>`,
            `<a href="https://paypal.com/x">${text}</a>`,
            `<script type="module">${some(script, 3)}</script>`,
            `<style>a::after { content: "${text}" }</style>`,
            `<!-- ${text} -->`,
            pick(['<input type="password">', "<input name=p\n type = 'password'>", '<INPUT TYPE=PASSWORD>', '<input type=text>', '<input data-x="a > b" type=password>']),
            text,
          ])
        );
      }
      const files = [{ path: 'index.html', content: nodes.join('\n') }];
      if (rnd() < 0.3) files.push({ path: 'main.js', content: some(script, 4) });
      expect(scanForPhishing(files, words)).toEqual(previousScan(files));
    }
  });
});

describe('moderation vocabulary', () => {
  it('normalizes a reported host from a URL, host:port or bare host', () => {
    expect(normalizeReportHost('https://Evil-Bank.apps.localhost:3041/login?x=1')).toBe('evil-bank.apps.localhost:3041');
    expect(normalizeReportHost('  evil--preview.drobek.app./path ')).toBe('evil--preview.drobek.app');
    expect(normalizeReportHost('evil.drobek.app')).toBe('evil.drobek.app');
    expect(normalizeReportHost('')).toBeNull();
    expect(normalizeReportHost('not a host')).toBeNull();
    expect(normalizeReportHost('javascript:alert(1)')).toBeNull();
    expect(normalizeReportHost(42)).toBeNull();
  });

  it('builds the report form URL on the dashboard origin and the terms URL', () => {
    const env = { PUBLIC_APP_URL: 'https://drobek.example/' };
    expect(reportFormUrl('x.apps.example', env)).toBe('https://drobek.example/report?host=x.apps.example');
    expect(termsUrl(env)).toBe('https://drobek.example/terms');
    expect(termsUrl({ ...env, TERMS_URL: 'https://example.com/tos' })).toBe('https://example.com/tos');
    expect(termsUrl({ ...env, TERMS_URL: 'javascript:alert(1)' })).toBe('https://drobek.example/terms');
  });

  it('names the category only', () => {
    expect(lockCategory('phishing')).toBe('phishing');
    expect(lockCategory('some internal note')).toBe('other');
    expect(lockedMessage('malware')).toMatch(/reason: malware/);
  });
});
