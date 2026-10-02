import { APP_CSP_SOURCES, appCspAllows, type AppCspDirective } from './app-csp.js';
import { CONFIG_FILE, type AppConfig } from './config.js';
import { blank, nextStartTag, replaceSpans } from './markup.js';
import { SOURCE_EXTS, extOf } from './paths.js';
import { tokenize, type Token } from './readiness/lexer.js';
import type { CompileMessage } from './types.js';

/**
 * Literal references the browser will fail to load: a same-app path the
 * version does not have (`missing_reference`) and a URL of another origin the
 * app CSP blocks (`blocked_by_csp`). Warnings only — they never stop a write.
 *
 * Read from the in-memory files, never executed: HTML `src`/`href` of
 * link/script/img/a/source/video/audio, icon `<meta>`s, web manifest icons,
 * CSS `url()` and `@import`, and in scripts (files and inline `<script>`s) a
 * string-literal first argument of `fetch()` / `new URL()`, `import()` and
 * static imports of a full URL, plus the `drobek.json` import map. Computed
 * values, `data:`/`blob:`/`mailto:`/`tel:` and other schemes, `#…`,
 * `/__drobek/…` and the build's own outputs are ignored. An extension-less
 * path is never missing: the app host answers it with index.html.
 */

export interface ReferenceScanInput {
  /** Every file of the version (paths normalized). */
  files: ReadonlyMap<string, unknown>;
  /** The UTF-8 text files among them. */
  text: ReadonlyMap<string, string>;
  config: Pick<AppConfig, 'imports' | 'entries'>;
  /** Paths served besides the version's files (the app's uploaded assets). */
  servedPaths?: Iterable<string>;
}

interface Ref {
  file: string;
  line: number;
  raw: string;
  /** How the reference reads in the message, e.g. `<script src>`. */
  what: string;
  /** The CSP directive that governs the load; null = navigation or fetched by someone else (no CSP check). */
  directive: AppCspDirective | null;
  /** Resolve a relative path against this app path; null = only root-absolute paths are checked. */
  base: string | null;
}

const ORIGIN = 'https://app.invalid/';
const SCRIPT_EXTS = new Set<string>(SOURCE_EXTS);
const FONT_EXT = /\.(?:woff2?|ttf|otf|eot)$/i;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const TEMPLATED = /[{}$<>`]|^%[A-Z_]+%/;
const GLOBALS = new Set(['window', 'globalThis', 'self']);

const JS_TYPE = /^(?:module|text\/javascript|application\/javascript)$/i;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"');]+))/gi;
/** An unquoted URL ends at a `(` unless it is escaped: CSS refuses an unescaped one, and stopping there keeps the scan linear. */
const CSS_URL = /url\(\s*(?:(?:"([^"]*)"|'([^']*)'|((?:[^()\s"']|(?<=\\)\()+))\s*)?\)/gi;
const META_IMAGE = /^(?:og:image|og:image:url|twitter:image|msapplication-tileimage|msapplication-config|msapplication-(?:square|wide)\d+x\d+logo)$/;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function linkDirective(rel: string[], as: string): AppCspDirective | null | undefined {
  if (rel.includes('stylesheet')) return 'style-src';
  if (rel.some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed' || r === 'mask-icon')) {
    return 'img-src';
  }
  if (rel.includes('manifest')) return 'default-src';
  if (rel.includes('modulepreload')) return 'script-src';
  if (rel.includes('preload') || rel.includes('prefetch')) {
    const byAs: Record<string, AppCspDirective> = {
      script: 'script-src',
      style: 'style-src',
      image: 'img-src',
      font: 'font-src',
      fetch: 'connect-src',
      audio: 'media-src',
      video: 'media-src',
      track: 'media-src',
    };
    return byAs[as] ?? 'default-src';
  }
  return undefined;
}

function scanHtml(file: string, source: string, refs: Ref[], manifests: Set<string>, inline: (code: string, line: number) => void): void {
  const text = replaceSpans(source, '<!--', '-->', blank);
  const starts = lineStarts(text);
  let from = 0;
  for (let t = nextStartTag(text, from); t; t = nextStartTag(text, from)) {
    from = t.end;
    const tag = t.name.toLowerCase();
    const attrs = new Map<string, { value: string; at: number }>();
    for (const a of t.attrs) {
      const name = a.name.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, { value: decodeEntities(a.value ?? ''), at: a.at });
    }
    const add = (attr: string, what: string, directive: AppCspDirective | null): void => {
      const v = attrs.get(attr);
      if (v) refs.push({ file, line: lineAt(starts, v.at), raw: v.value, what, directive, base: file });
    };

    if (tag === 'script' || tag === 'style') {
      const close = new RegExp(`</${tag}\\s*>`, 'ig');
      close.lastIndex = from;
      const end = close.exec(text);
      const body = text.slice(from, end ? end.index : text.length);
      const bodyLine = lineAt(starts, from);
      if (tag === 'script') {
        if (attrs.has('src')) add('src', '<script src>', 'script-src');
        else if (!attrs.has('type') || JS_TYPE.test(attrs.get('type')!.value.trim())) inline(body, bodyLine);
      } else {
        scanCss(file, body, refs, bodyLine);
      }
      from = end ? close.lastIndex : text.length;
      continue;
    }

    switch (tag) {
      case 'link': {
        const rel = (attrs.get('rel')?.value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const directive = linkDirective(rel, (attrs.get('as')?.value ?? '').toLowerCase());
        if (directive === undefined) break;
        add('href', `<link rel="${rel.join(' ')}" href>`, directive);
        if (rel.includes('manifest')) {
          const href = attrs.get('href')?.value ?? '';
          const local = localPath(href, file);
          if (local) manifests.add(local);
        }
        break;
      }
      case 'img':
        add('src', '<img src>', 'img-src');
        break;
      case 'source':
      case 'video':
      case 'audio':
        add('src', `<${tag} src>`, 'media-src');
        if (tag === 'video') add('poster', '<video poster>', 'img-src');
        break;
      case 'a':
        add('href', '<a href>', null);
        break;
      case 'meta': {
        const key = (attrs.get('name')?.value ?? attrs.get('property')?.value ?? '').toLowerCase();
        if (META_IMAGE.test(key)) add('content', `<meta ${attrs.has('name') ? 'name' : 'property'}="${key}">`, null);
        break;
      }
    }
  }
}

// ── CSS ──────────────────────────────────────────────────────────────────────

function scanCss(file: string, source: string, refs: Ref[], firstLine = 1): void {
  const text = replaceSpans(source, '/*', '*/', blank);
  const starts = lineStarts(text);
  const line = (i: number): number => lineAt(starts, i) + firstLine - 1;
  const imports = new Set<number>();
  CSS_IMPORT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CSS_IMPORT.exec(text))) {
    const urlAt = m[0].indexOf('url(');
    if (urlAt !== -1) imports.add(m.index + urlAt);
    refs.push({ file, line: line(m.index), raw: m[1] ?? m[2] ?? m[3] ?? '', what: '@import', directive: 'style-src', base: file });
  }
  CSS_URL.lastIndex = 0;
  while ((m = CSS_URL.exec(text))) {
    if (imports.has(m.index)) continue;
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    const directive = FONT_EXT.test(raw.replace(/[?#].*$/, '')) ? 'font-src' : 'img-src';
    refs.push({ file, line: line(m.index), raw, what: 'CSS url()', directive, base: file });
  }
}

// ── scripts ──────────────────────────────────────────────────────────────────

const isP = (t: Token | undefined, v: string): boolean => t?.type === 'punct' && t.value === v;
const isN = (t: Token | undefined, v: string): boolean => t?.type === 'name' && t.value === v;
const literal = (t: Token | undefined): string | null =>
  t && (t.type === 'str' || (t.type === 'tpl' && (t.subs?.length ?? 0) === 0)) ? t.value : null;
/** The literal argument at `i` when it is the whole argument (followed by `,` or `)`). */
const wholeArg = (toks: Token[], i: number): string | null =>
  isP(toks[i + 1], ',') || isP(toks[i + 1], ')') ? literal(toks[i]) : null;
const isFullUrl = (s: string): boolean => /^(?:https?:)?\/\//i.test(s);

function scanScript(file: string, source: string, refs: Ref[], firstLine = 1): void {
  let toks: Token[];
  try {
    toks = tokenize(source, firstLine);
  } catch {
    return;
  }
  const push = (t: Token, raw: string, what: string, directive: AppCspDirective | null): void => {
    refs.push({ file, line: t.line, raw, what, directive, base: null });
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (isN(t, 'fetch') && isP(toks[i + 1], '(')) {
      const prev = toks[i - 1];
      if (isP(prev, '.') && !GLOBALS.has(toks[i - 2]?.value ?? '')) continue;
      if (isP(prev, '?.')) continue;
      const arg = wholeArg(toks, i + 2);
      if (arg !== null) push(toks[i + 2], arg, 'fetch()', 'connect-src');
      else if (isN(toks[i + 2], 'new') && isN(toks[i + 3], 'URL') && isP(toks[i + 4], '(')) {
        const url = wholeArg(toks, i + 5);
        if (url !== null) push(toks[i + 5], url, 'fetch(new URL())', 'connect-src');
        i += 5;
      }
      continue;
    }
    if (isN(t, 'new') && isN(toks[i + 1], 'URL') && isP(toks[i + 2], '(')) {
      // A URL object alone loads nothing: only a same-app path it names is checked.
      const url = wholeArg(toks, i + 3);
      if (url !== null) push(toks[i + 3], url, 'new URL()', null);
      continue;
    }
    if (isN(t, 'import') && isP(toks[i + 1], '(') && !isP(toks[i - 1], '.')) {
      const spec = wholeArg(toks, i + 2);
      if (spec !== null && isFullUrl(spec)) push(toks[i + 2], spec, 'import()', 'script-src');
      continue;
    }
    if ((isN(t, 'from') || isN(t, 'import')) && !isP(toks[i - 1], '.')) {
      const spec = literal(toks[i + 1]);
      if (spec !== null && toks[i + 1].type === 'str' && isFullUrl(spec)) push(toks[i + 1], spec, 'import', 'script-src');
    }
  }
}

// ── web manifest ─────────────────────────────────────────────────────────────

function scanManifest(file: string, text: string, refs: Ref[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const icons = (parsed as { icons?: unknown })?.icons;
  if (!Array.isArray(icons)) return;
  const starts = lineStarts(text);
  for (const icon of icons) {
    const src = (icon as { src?: unknown })?.src;
    if (typeof src !== 'string') continue;
    const at = text.indexOf(JSON.stringify(src));
    refs.push({ file, line: at === -1 ? 1 : lineAt(starts, at), raw: src, what: 'manifest icon', directive: 'img-src', base: file });
  }
}

// ── resolution ───────────────────────────────────────────────────────────────

/** The app path a same-app reference names, or null (external, another scheme, a route, nothing to check). */
function localPath(raw: string, base: string | null): string | null {
  const ref = raw.trim();
  if (ref === '' || ref.startsWith('#') || ref.startsWith('?') || TEMPLATED.test(ref)) return null;
  if (SCHEME.test(ref) || ref.startsWith('//')) return null;
  if (base === null && !ref.startsWith('/')) return null;
  let url: URL;
  try {
    url = new URL(ref, ORIGIN + (base ?? ''));
  } catch {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (path.startsWith('/__drobek/')) return null;
  return path.slice(1);
}

function externalUrl(raw: string): URL | null {
  const ref = raw.trim();
  if (TEMPLATED.test(ref)) return null;
  const full = ref.startsWith('//') ? `https:${ref}` : ref;
  const scheme = SCHEME.exec(full)?.[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  try {
    return new URL(full);
  } catch {
    return null;
  }
}

function blockedFix(directive: AppCspDirective, url: URL): string {
  if (url.protocol === 'http:' && (APP_CSP_SOURCES[directive] as readonly string[]).includes('https:')) {
    return 'Use the https:// URL, or add the file to the app.';
  }
  switch (directive) {
    case 'connect-src':
      return "Call the API through a proxy upstream of the proxy module (skill_info('proxy')), or add the data to the app's files.";
    case 'script-src':
      return 'Load it from a pinned https://esm.sh URL (drobek.json imports for a package), or add the script to the app.';
    default:
      return 'Add the file to the app and reference its path.';
  }
}

function allowedList(directive: AppCspDirective): string {
  return APP_CSP_SOURCES[directive].filter((s) => s !== "'unsafe-inline'").join(' ');
}

/** Scan a version's files for broken references (see the module comment). */
export function scanReferences(input: ReferenceScanInput): CompileMessage[] {
  const refs: Ref[] = [];
  const manifests = new Set<string>();

  for (const [file, text] of input.text) {
    const ext = extOf(file);
    if (ext === '.html') {
      scanHtml(file, text, refs, manifests, (code, line) => scanScript(file, code, refs, line));
    } else if (ext === '.css') {
      scanCss(file, text, refs);
    } else if (SCRIPT_EXTS.has(ext)) {
      scanScript(file, text, refs);
    } else if (ext === '.webmanifest') {
      manifests.add(file);
    }
  }
  for (const file of manifests) {
    const text = input.text.get(file);
    if (text !== undefined) scanManifest(file, text, refs);
  }

  const known = new Set<string>([...input.files.keys(), ...(input.servedPaths ?? [])]);
  for (const name of Object.keys(input.config.entries)) {
    for (const out of [`${name}.js`, `${name}.css`, `${name}.js.map`, `${name}.css.map`]) known.add(out);
  }

  const out: CompileMessage[] = [];
  const seen = new Set<string>();
  const report = (key: string, msg: CompileMessage): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(msg);
  };

  for (const ref of refs) {
    const url = externalUrl(ref.raw);
    if (url) {
      if (ref.directive === null || appCspAllows(ref.directive, url)) continue;
      report(`csp\0${ref.file}\0${ref.line}\0${url.href}`, {
        code: 'blocked_by_csp',
        file: ref.file,
        line: ref.line,
        text: `${ref.what} "${url.href}" is blocked by the app CSP: ${ref.directive} allows only ${allowedList(ref.directive)}. ${blockedFix(ref.directive, url)}`,
      });
      continue;
    }
    const path = localPath(ref.raw, ref.base);
    if (path === null || path === '' || path.endsWith('/')) continue;
    const last = path.slice(path.lastIndexOf('/') + 1);
    if (!/\.[^.]+$/.test(last) || known.has(path)) continue;
    report(`missing\0${ref.file}\0${path}`, {
      code: 'missing_reference',
      file: ref.file,
      line: ref.line,
      text: `${ref.what} "${ref.raw.trim()}" points to ${path}, which this version does not have: the browser gets a 404. Add the file (an image, video or font can be uploaded with create_asset_upload), fix the path, or remove the reference.`,
    });
  }

  const imports = input.config.imports;
  const configText = input.text.get(CONFIG_FILE) ?? '';
  const configStarts = lineStarts(configText);
  for (const [name, raw] of Object.entries(imports)) {
    const url = externalUrl(raw);
    if (!url || appCspAllows('script-src', url)) continue;
    const at = configText.indexOf(JSON.stringify(raw));
    report(`csp\0${CONFIG_FILE}\0${name}`, {
      code: 'blocked_by_csp',
      file: CONFIG_FILE,
      ...(at === -1 ? {} : { line: lineAt(configStarts, at) }),
      text: `drobek.json imports "${name}" → "${url.href}" is blocked by the app CSP: script-src allows only ${allowedList('script-src')}. Use the package's pinned https://esm.sh URL instead.`,
    });
  }
  return out;
}
