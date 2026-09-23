/**
 * The publish heuristic (M4-02, NSO-293): a cheap, NON-BLOCKING phishing
 * signal. A version is flagged when BOTH hold:
 *   1. it renders a password field — `<input type="password">` in HTML, or
 *      `type: "password"` / `type="password"` / `setAttribute("type",
 *      "password")` in JS (inline scripts and the built bundle);
 *   2. a foreign brand word (ABUSE_BRAND_WORDS, comma-separated; default
 *      below) appears in the page's `<title>`, an `<h1>`, the visible HTML
 *      text, or a string literal of the JS (where JSX text ends up).
 * Matching is case- and diacritics-insensitive on whole words (a phrase like
 * "bank of america" must appear as those words); URLs and domain names are
 * ignored, so `fonts.googleapis.com` or a `https://google.com` link is not a
 * brand mention. A flag only puts the app into the super-admin queue —
 * nothing is refused, nothing is shown to the app's owner. Pure — no I/O.
 */

/** Brand names phishing pages imitate most (banks, payments, e-mail, social, crypto). */
export const DEFAULT_ABUSE_BRAND_WORDS: readonly string[] = [
  'paypal',
  'apple id',
  'icloud',
  'google',
  'gmail',
  'microsoft',
  'outlook',
  'office 365',
  'facebook',
  'instagram',
  'whatsapp',
  'netflix',
  'amazon',
  'coinbase',
  'binance',
  'metamask',
  'revolut',
  'wells fargo',
  'bank of america',
  'ceska sporitelna',
  'komercni banka',
  'csob',
  'raiffeisen',
  'bank',
  'banking',
];

/** Lower-case, strip diacritics, every non-alphanumeric run → one space. */
function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

/** ABUSE_BRAND_WORDS (comma-separated) → normalized words; unset or empty → the default list. */
export function brandWordsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.ABUSE_BRAND_WORDS?.trim();
  const list = raw ? raw.split(',') : [...DEFAULT_ABUSE_BRAND_WORDS];
  const out = new Set<string>();
  for (const w of list) {
    const n = normalizeText(w).trim();
    if (n.length >= 2) out.add(n);
  }
  return [...out];
}

const URL_RE = /(?:https?:)?\/\/[^\s"'`<>)]+/gi;
const DOMAIN_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|app|dev|cz|sk|eu|co|us|uk|de)\b/gi;

function stripUrls(text: string): string {
  return text.replace(URL_RE, ' ').replace(DOMAIN_RE, ' ');
}

function safeChar(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,7});/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)));
}

const HTML_PASSWORD_RE = /<input\b[^>]*\btype\s*=\s*["']?password\b/i;
const JS_PASSWORD_RES = [
  // JSX compiled by esbuild: jsx("input", { type: "password" })
  /\btype\s*:\s*["'`]password["'`]/i,
  // markup inside a string / template: '<input type="password">', innerHTML
  /\btype\s*=\s*\\?["'`]?password\b/i,
  // el.setAttribute("type", "password")
  /["'`]type["'`]\s*,\s*["'`]password["'`]/i,
];

function hasJsPassword(js: string): boolean {
  return JS_PASSWORD_RES.some((re) => re.test(js));
}

type Where = 'title' | 'h1' | 'text' | 'js';

interface Texts {
  title: string[];
  h1: string[];
  text: string[];
  js: string[];
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' '));
}

/** The string literals of a JS source (where JSX text and `document.title = …` end up). */
function jsStrings(js: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\\n]|\\.){1,500})"|'((?:[^'\\\n]|\\.){1,500})'|`((?:[^`\\]|\\.){1,2000})`/g;
  for (const m of js.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

export interface HeuristicFile {
  path: string;
  content: string;
}

export interface HeuristicFinding {
  flagged: boolean;
  /** The files a password field was found in; empty = none. */
  passwordIn: string[];
  /** The brand words that matched, each with the first place it was seen. */
  brands: { word: string; where: Where }[];
}

/**
 * Scan a version's HTML and JS files. `words` are normalized brand words
 * (brandWordsFromEnv). Flagged only when a password field AND a brand word
 * are both present.
 */
export function scanForPhishing(files: readonly HeuristicFile[], words: readonly string[]): HeuristicFinding {
  const passwordIn: string[] = [];
  const texts: Texts = { title: [], h1: [], text: [], js: [] };
  for (const f of files) {
    const lower = f.path.toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      const html = f.content;
      let password = HTML_PASSWORD_RE.test(html);
      texts.title.push(...[...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => stripTags(m[1])));
      texts.h1.push(...[...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripTags(m[1])));
      // Inline scripts can build the form too.
      for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (hasJsPassword(m[1])) password = true;
        texts.js.push(...jsStrings(m[1]));
      }
      const body = html
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ');
      texts.text.push(stripTags(body));
      if (password) passwordIn.push(f.path);
    } else if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
      if (hasJsPassword(f.content)) passwordIn.push(f.path);
      texts.js.push(...jsStrings(f.content));
    }
  }

  const brands: HeuristicFinding['brands'] = [];
  if (words.length > 0) {
    const pad = (list: string[]) => ` ${normalizeText(stripUrls(list.join('\n')))} `;
    const hay: Record<Where, string> = {
      title: pad(texts.title),
      h1: pad(texts.h1),
      text: pad(texts.text),
      js: pad(texts.js),
    };
    for (const word of words) {
      const needle = ` ${word} `;
      const where = (['title', 'h1', 'text', 'js'] as const).find((w) => hay[w].includes(needle));
      if (where) brands.push({ word, where });
    }
  }
  return { flagged: passwordIn.length > 0 && brands.length > 0, passwordIn, brands };
}

/** One line for the queue / the log: what the heuristic saw. */
export function describeFinding(finding: HeuristicFinding, version: number): string {
  const words = finding.brands.map((b) => `"${b.word}" (${b.where})`).join(', ');
  return `Publish check, version ${version}: a password field (${finding.passwordIn.join(', ')}) and the brand word(s) ${words}. Review the app before acting — a heuristic, not a verdict.`;
}
