/**
 * The publish heuristic: a cheap, NON-BLOCKING phishing
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
import { replaceSpans } from '@drobek/compile';

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
/**
 * Starts only where a dotted name starts (not after a letter, digit, `_`,
 * `-` or `x.`), so a long `a.b.c…` or `a-b-c…` run is read once, not once
 * per label; a name glued to a leading `_` is read as words.
 */
const DOMAIN_RE = /(?<![\w-]|[a-z0-9-]\.)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|app|dev|cz|sk|eu|co|us|uk|de)\b/gi;

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

const INPUT_TAG = /<input\b/gi;
const PASSWORD_TYPE = /\btype\s*=\s*["']?password\b/i;
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

/**
 * The scans below read the text once from left to right (an unclosed tag,
 * comment or element costs no more than a closed one) and find what the
 * regular expression in each comment finds; `replaceSpans(text, open,
 * close, space)` is `text.replace(/open[\s\S]*?close/g, ' ')`.
 */

const space = (): string => ' ';

/** `html` with every `<name…</name>` replaced by a space (`/<name\b[\s\S]*?<\/name>/gi`). */
function withoutElements(html: string, name: string): string {
  const open = new RegExp(`<${name}\\b`, 'gi');
  const close = new RegExp(`</${name}>`, 'gi');
  let out = '';
  let from = 0;
  for (;;) {
    open.lastIndex = from;
    const m = open.exec(html);
    if (!m) break;
    close.lastIndex = open.lastIndex;
    const c = close.exec(html);
    if (!c) break;
    out += `${html.slice(from, m.index)} `;
    from = close.lastIndex;
  }
  return out + html.slice(from);
}

/** The content of every `<name …>…</name>` (`/<name\b[^>]*>([\s\S]*?)<\/name>/gi`). */
function contents(html: string, name: string): string[] {
  const open = new RegExp(`<${name}\\b`, 'gi');
  const close = new RegExp(`</${name}>`, 'gi');
  const out: string[] = [];
  for (let from = 0; ; ) {
    open.lastIndex = from;
    const m = open.exec(html);
    if (!m) break;
    const gt = html.indexOf('>', open.lastIndex);
    if (gt === -1) break;
    close.lastIndex = gt + 1;
    const c = close.exec(html);
    if (!c) break;
    out.push(html.slice(gt + 1, c.index));
    from = close.lastIndex;
  }
  return out;
}

/** An `<input>` whose start tag says `type=password` (`/<input\b[^>]*\btype\s*=\s*["']?password\b/i`). */
function hasPasswordInput(html: string): boolean {
  for (let from = 0; ; ) {
    INPUT_TAG.lastIndex = from;
    const m = INPUT_TAG.exec(html);
    if (!m) return false;
    const gt = html.indexOf('>', INPUT_TAG.lastIndex);
    if (PASSWORD_TYPE.test(html.slice(m.index, gt === -1 ? html.length : gt))) return true;
    if (gt === -1) return false;
    from = gt + 1;
  }
}

function stripTags(s: string): string {
  return decodeEntities(replaceSpans(s, '<', '>', space));
}

/** Push the string literals of a JS source (where JSX text and `document.title = …` end up) onto `out`. */
function pushJsStrings(js: string, out: string[]): void {
  const re = /"((?:[^"\\\n]|\\.){1,500})"|'((?:[^'\\\n]|\\.){1,500})'|`((?:[^`\\]|\\.){1,2000})`/g;
  for (const m of js.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
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
      let password = hasPasswordInput(html);
      for (const title of contents(html, 'title')) texts.title.push(stripTags(title));
      for (const h1 of contents(html, 'h1')) texts.h1.push(stripTags(h1));
      // Inline scripts can build the form too.
      for (const script of contents(html, 'script')) {
        if (hasJsPassword(script)) password = true;
        pushJsStrings(script, texts.js);
      }
      const body = replaceSpans(withoutElements(withoutElements(html, 'script'), 'style'), '<!--', '-->', space);
      texts.text.push(stripTags(body));
      if (password) passwordIn.push(f.path);
    } else if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
      if (hasJsPassword(f.content)) passwordIn.push(f.path);
      pushJsStrings(f.content, texts.js);
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
