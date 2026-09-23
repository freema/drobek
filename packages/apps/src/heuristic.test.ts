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

describe('publish heuristic (NSO-293)', () => {
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
