/**
 * The fetch directives of the app Content-Security-Policy: the one list both
 * the app hosts (@drobek/serving builds the header from it) and the
 * compiler's reference check (references.ts) read. frame-src is not here: it
 * depends on the operator's APP_FRAME_SRC_EXTRA, which only serving knows.
 */
export const APP_CSP_SOURCES = {
  'default-src': ["'self'"],
  'script-src': ["'self'", 'https://esm.sh', "'unsafe-inline'"],
  'style-src': ["'self'", "'unsafe-inline'", 'https:'],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'font-src': ["'self'", 'data:', 'https:'],
  'connect-src': ["'self'", 'https://esm.sh'],
  'media-src': ["'self'", 'blob:', 'https:'],
} as const satisfies Record<string, readonly string[]>;

export type AppCspDirective = keyof typeof APP_CSP_SOURCES;

/** `directive source …` for each entry of APP_CSP_SOURCES, in order. */
export function appCspFetchDirectives(): string[] {
  return Object.entries(APP_CSP_SOURCES).map(([directive, sources]) => `${directive} ${sources.join(' ')}`);
}

function sourceMatches(source: string, url: URL): boolean {
  if (source.startsWith("'")) return false;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) {
    const scheme = source.toLowerCase();
    return url.protocol === scheme || (scheme === 'http:' && url.protocol === 'https:');
  }
  let host: URL;
  try {
    host = new URL(source);
  } catch {
    return false;
  }
  const schemeOk = host.protocol === url.protocol || (host.protocol === 'http:' && url.protocol === 'https:');
  return schemeOk && host.host === url.host;
}

/**
 * Whether `directive` of the app CSP lets the browser load `url`, a URL of
 * another origin than the app (`'self'` never matches it).
 */
export function appCspAllows(directive: AppCspDirective, url: URL): boolean {
  return APP_CSP_SOURCES[directive].some((s) => sourceMatches(s, url));
}
