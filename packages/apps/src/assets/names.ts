/**
 * App asset paths and types (NSO-358). PURE.
 *
 * An asset lives in the SAME URL space as the app's files: the asset
 * `img/s1.jpg` is served at `/img/s1.jpg` on every host of its app, so a page
 * ported from elsewhere (a Claude artifact with `<video src="film.mp4">` and
 * relative `s1.jpg` thumbnails) needs no path rewriting. Its name is a
 * relative path of 1–4 segments, each `[A-Za-z0-9][A-Za-z0-9._-]{0,99}` (no
 * `.` / `..`, no hidden or `__drobek` segment), at most 200 characters, whose
 * extension says which types it may hold. The TYPE itself always comes from
 * the bytes (sniff.ts): a name only narrows what is accepted, never promotes
 * (an HTML page named `film.mp4` is refused).
 */

/** Every type an asset can have — the sniffer's verdict, served as Content-Type. */
export const ASSET_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'font/woff',
  'font/woff2',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** Extension → the types a name with it may hold. */
export const ASSET_EXTENSIONS: Readonly<Record<string, readonly AssetType[]>> = Object.freeze({
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  svg: ['image/svg+xml'],
  mp4: ['video/mp4', 'audio/mp4'],
  m4v: ['video/mp4'],
  m4a: ['audio/mp4'],
  webm: ['video/webm'],
  mp3: ['audio/mpeg'],
  ogg: ['audio/ogg'],
  oga: ['audio/ogg'],
  wav: ['audio/wav'],
  woff: ['font/woff'],
  woff2: ['font/woff2'],
});

/** One path segment of an asset name. */
export const ASSET_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const ASSET_NAME_MAX = 200;
export const ASSET_NAME_MAX_DEPTH = 4;

/** Is `name` a well-formed asset path (1–4 segments, ≤ 200 chars)? The extension is checked separately. */
function wellFormed(name: string): boolean {
  if (name.length === 0 || name.length > ASSET_NAME_MAX) return false;
  const segments = name.split('/');
  return segments.length <= ASSET_NAME_MAX_DEPTH && segments.every((s) => ASSET_SEGMENT_RE.test(s));
}

/** Where an asset is served on its app's hosts: `/<name>`. */
export function assetPath(name: string): string {
  return `/${name}`;
}

/** The last segment of an asset name (a download file name). */
export function assetFileName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

function extensionOfName(name: string): string {
  const file = assetFileName(name);
  const dot = file.lastIndexOf('.');
  return dot <= 0 ? '' : file.slice(dot + 1).toLowerCase();
}

/** The types `name` may hold, or null when the name or its extension is not allowed. */
export function assetTypesForName(name: string): readonly AssetType[] | null {
  if (typeof name !== 'string' || !wellFormed(name)) return null;
  return ASSET_EXTENSIONS[extensionOfName(name)] ?? null;
}

/** Why `name` is not a valid asset path (a sentence for the caller), or null when it is. */
export function assetNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'The asset path is missing.';
  if (!wellFormed(name)) {
    return `"${name.slice(0, 120)}" is not a valid asset path: a relative path like film.mp4 or img/s1.jpg — at most ${ASSET_NAME_MAX_DEPTH} segments and ${ASSET_NAME_MAX} characters, each segment letters, digits, ".", "_" and "-", starting with a letter or digit (no leading "/", no "..").`;
  }
  if (!assetTypesForName(name)) {
    return `"${name}" has no allowed extension: use ${Object.keys(ASSET_EXTENSIONS).map((e) => `.${e}`).join(' ')}.`;
  }
  return null;
}

/** `video/mp4; codecs=…` → `video/mp4` (lower-case, no parameters). */
export function normalizeContentType(raw: unknown): string {
  return typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : '';
}

/** `video` of `video/mp4` — what a declared Content-Type must share with the sniffed type. */
export function typeFamily(type: string): string {
  return normalizeContentType(type).split('/')[0] ?? '';
}

const ASSET_TYPE_SET: ReadonlySet<string> = new Set(ASSET_TYPES);

export function isAssetType(type: string): type is AssetType {
  return ASSET_TYPE_SET.has(type);
}

/**
 * Does a declared Content-Type fit `name`? It must be one of the name's
 * types or at least share their family (`image/png` for `film.mp4` does
 * not; `audio/x-m4a` for `song.m4a` does — the bytes decide the rest). An
 * empty or `application/octet-stream` declaration is fine.
 */
export function declaredTypeFits(name: string, declared: string): boolean {
  const types = assetTypesForName(name);
  if (!types) return false;
  const t = normalizeContentType(declared);
  if (t === '' || t === 'application/octet-stream') return true;
  return types.some((x) => x === t || typeFamily(x) === typeFamily(t));
}
