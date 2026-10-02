/**
 * read_file: one or several source files of a version, whole or a line range
 * of each, or — with `search` — the lines of its text files that contain a
 * literal text. Viewer+ in the app's workspace.
 *
 *  - The first file always comes back; each further one only while the text
 *    returned stays within COMPILE_MAX_FILE_BYTES (`deps.limits.maxFileBytes`,
 *    the most one file can hold) — the rest is listed under `omitted`.
 *  - A requested path the version does not have is listed under `missing`;
 *    when none of them exists the call answers not_found.
 *  - The search is a literal substring match, line by line: no pattern
 *    language, so its time stays linear in the size of the version.
 *  - Everything here is app-written content: register.ts answers it inside
 *    the untrusted envelope only, never as structuredContent.
 */
import {
  READ_FILE_PATHS_MAX,
  READ_FILE_SEARCH_MATCHES_DEFAULT,
  READ_FILE_SEARCH_MATCHES_MAX,
  READ_FILE_SEARCH_MAX_CHARS,
} from '@drobek/agent-dx';
import { getVersion, readBlobs } from '@drobek/apps';
import { BINARY_EXTS, normalizeAppPath } from '@drobek/compile';
import { authorizeApp } from './access.js';
import { ToolError } from './errors.js';
import { latestVersions } from './queries.js';
import { missingVersion, type CallContext } from './tools.js';

export interface ReadFileArgs {
  app_id: string;
  path?: string;
  paths?: string[];
  version?: number;
  offset?: number;
  limit?: number;
  search?: string;
  ignore_case?: boolean;
}

/** One file of the answer: its text (whole or `lines`) or, for a binary file, its size. */
interface ReadFileEntry {
  path: string;
  content?: string;
  binary?: true;
  size?: number;
  total_lines?: number;
  /** The range returned when `offset` / `limit` was given; null = the file ends before `offset`. */
  lines?: { from: number; to: number } | null;
}

/** A file that did not fit into the text one call returns. */
interface OmittedFile {
  path: string;
  /** The bytes it would have returned (the range, when one was asked for). */
  bytes: number;
  total_lines: number;
}

export interface ReadFilesResult {
  kind: 'files';
  version: number;
  untrusted: true;
  files: ReadFileEntry[];
  omitted: OmittedFile[];
  missing: string[];
  /** COMPILE_MAX_FILE_BYTES: the text one call returns. */
  max_bytes: number;
}

interface SearchMatch {
  path: string;
  /** 1-based line and column of the first match in the line. */
  line: number;
  column: number;
  /** The line, trimmed; cut to a window around the match when longer than SNIPPET_CHARS. */
  text: string;
}

export interface SearchFilesResult {
  kind: 'search';
  version: number;
  untrusted: true;
  matches: SearchMatch[];
  /** Every matching line, also those past `limit`. */
  total: number;
  files_searched: number;
  missing: string[];
  limit: number;
}

export type ReadFileResult = ReadFilesResult | SearchFilesResult;

const utf8 = new TextDecoder('utf-8', { fatal: true });

const SNIPPET_CHARS = 200;
const SNIPPET_BEFORE = 60;

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i <= path.lastIndexOf('/') ? '' : path.slice(i).toLowerCase();
}

/** The text of a file, or null for a binary one (by extension, or bytes that are not UTF-8). */
function textOf(path: string, bytes: Buffer): string | null {
  if (BINARY_EXTS.has(extOf(path))) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** The number of lines of `text`: a final line break ends the last line, it does not start another. */
export function countLines(text: string): number {
  if (text === '') return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n += 1;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Lines `offset` … `offset + limit - 1` (1-based) of `text`, exactly as stored
 * (each with its own line break); null when the text ends before `offset`.
 */
export function selectLines(
  text: string,
  offset: number,
  limit: number | undefined,
  total = countLines(text)
): { content: string; from: number; to: number } | null {
  if (offset > total) return null;
  let start = 0;
  for (let line = 1; line < offset; line += 1) start = text.indexOf('\n', start) + 1;
  const to = limit === undefined ? total : Math.min(total, offset + limit - 1);
  let end = start;
  for (let line = offset; line <= to; line += 1) {
    const nl = text.indexOf('\n', end);
    end = nl === -1 ? text.length : nl + 1;
  }
  return { content: text.slice(start, end), from: offset, to };
}

/** The line around a match: trimmed, and cut to a window around the match when long. */
function snippet(line: string, at: number, length: number): string {
  const width = Math.max(SNIPPET_CHARS, length + 2 * SNIPPET_BEFORE);
  if (line.length <= width) return line.trim();
  const start = Math.max(0, Math.min(at - SNIPPET_BEFORE, line.length - width));
  const end = start + width;
  return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
}

/**
 * The lines of `files` that contain `query` (literal; no line breaks), in
 * file order: at most `max` of them, and the count of all. One indexOf per
 * line — linear in the size of the files, whatever the text.
 */
export function searchLines(
  files: Iterable<[string, string]>,
  query: string,
  opts: { ignoreCase?: boolean; max: number }
): { matches: SearchMatch[]; total: number } {
  const needle = opts.ignoreCase ? query.toLowerCase() : query;
  const matches: SearchMatch[] = [];
  let total = 0;
  for (const [path, text] of files) {
    let start = 0;
    for (let line = 1; start <= text.length; line += 1) {
      const nl = text.indexOf('\n', start);
      const end = nl === -1 ? text.length : nl;
      const raw = text.slice(start, end);
      const at = (opts.ignoreCase ? raw.toLowerCase() : raw).indexOf(needle);
      if (at !== -1) {
        total += 1;
        if (matches.length < opts.max) matches.push({ path, line, column: at + 1, text: snippet(raw, at, needle.length) });
      }
      if (nl === -1) break;
      start = nl + 1;
    }
  }
  return { matches, total };
}

function positiveInt(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ToolError('invalid_params', `\`${name}\` must be a positive integer.`);
  }
  return value;
}

/** `s` without its trailing slashes (a loop, not a regex: linear on any input). */
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end -= 1;
  return s.slice(0, end);
}

/** `path` and `paths` as one normalized list (`path` first, duplicates dropped); a search also takes folders (`src/`). */
function requestedPaths(args: ReadFileArgs, folders: boolean): string[] {
  const raw = [...(args.path !== undefined ? [args.path] : []), ...(args.paths ?? [])];
  if (raw.length > READ_FILE_PATHS_MAX) {
    throw new ToolError('invalid_params', `At most ${READ_FILE_PATHS_MAX} paths per call — split the read into several calls.`);
  }
  const out: string[] = [];
  for (const p of raw) {
    const s = String(p ?? '');
    const path = normalizeAppPath(folders ? trimTrailingSlashes(s) : s);
    if (!path) throw new ToolError('invalid_path', `Unsafe file path ${JSON.stringify(p)}.`);
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

export async function readFile(ctx: CallContext, args: ReadFileArgs): Promise<ReadFileResult> {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  const versionArg = positiveInt('version', args.version);
  const offset = positiveInt('offset', args.offset);
  const limit = positiveInt('limit', args.limit);
  const search = args.search;
  if (search !== undefined) {
    if (typeof search !== 'string' || search.length === 0 || search.length > READ_FILE_SEARCH_MAX_CHARS) {
      throw new ToolError('invalid_params', `\`search\` must be 1–${READ_FILE_SEARCH_MAX_CHARS} characters of literal text.`);
    }
    if (/[\r\n]/.test(search)) {
      throw new ToolError('invalid_params', '`search` matches within one line: send it without line breaks.');
    }
    if (offset !== undefined) {
      throw new ToolError('invalid_params', '`offset` is for reading lines, not for `search`: narrow the search with `path` / `paths` or raise `limit`.');
    }
    if (limit !== undefined && limit > READ_FILE_SEARCH_MATCHES_MAX) {
      throw new ToolError('invalid_params', `With \`search\`, \`limit\` is at most ${READ_FILE_SEARCH_MATCHES_MAX} matching lines.`);
    }
  }
  const wanted = requestedPaths(args, search !== undefined);
  if (search === undefined && wanted.length === 0) {
    throw new ToolError('invalid_params', `Pass \`path\` (one file), \`paths\` (up to ${READ_FILE_PATHS_MAX}) or \`search\`.`);
  }

  const number = versionArg ?? (await latestVersions([app.id])).get(app.id)?.number;
  const version = number ? await getVersion(app.id, { number }) : null;
  if (!version) {
    throw number ? await missingVersion(ctx, app, number) : new ToolError('not_found', 'The app has no versions yet.');
  }
  const sources = version.files.filter((f) => f.kind === 'source');

  if (search !== undefined) {
    const inScope = (path: string) => wanted.length === 0 || wanted.some((w) => path === w || path.startsWith(`${w}/`));
    const missing = wanted.filter((w) => !sources.some((f) => f.path === w || f.path.startsWith(`${w}/`)));
    if (wanted.length > 0 && missing.length === wanted.length) {
      throw new ToolError(
        'not_found',
        wanted.length === 1
          ? `No file or folder "${wanted[0]}" in version ${version.number}.`
          : `None of the ${wanted.length} paths is a file or folder of version ${version.number}.`
      );
    }
    const files = sources.filter((f) => inScope(f.path) && !BINARY_EXTS.has(extOf(f.path)));
    const blobs = await readBlobs(files.map((f) => f.sha256));
    const texts: [string, string][] = [];
    for (const f of files) {
      const bytes = blobs.get(f.sha256);
      const text = bytes ? textOf(f.path, bytes) : null;
      if (text !== null) texts.push([f.path, text]);
    }
    const max = limit ?? READ_FILE_SEARCH_MATCHES_DEFAULT;
    const { matches, total } = searchLines(texts, search, { ignoreCase: args.ignore_case === true, max });
    return { kind: 'search', version: version.number, untrusted: true, matches, total, files_searched: texts.length, missing, limit: max };
  }

  const byPath = new Map(sources.map((f) => [f.path, f]));
  const found = wanted.filter((p) => byPath.has(p));
  const missing = wanted.filter((p) => !byPath.has(p));
  if (found.length === 0) {
    throw new ToolError(
      'not_found',
      wanted.length === 1
        ? `No file "${wanted[0]}" in version ${version.number}.`
        : `None of the ${wanted.length} paths is a file of version ${version.number}.`
    );
  }
  const blobs = await readBlobs(found.map((p) => byPath.get(p)!.sha256));
  const maxBytes = ctx.deps.limits.maxFileBytes;
  const ranged = offset !== undefined || limit !== undefined;
  const files: ReadFileEntry[] = [];
  const omitted: OmittedFile[] = [];
  let used = 0;
  for (const path of found) {
    const bytes = blobs.get(byPath.get(path)!.sha256);
    if (!bytes) {
      missing.push(path);
      continue;
    }
    const text = textOf(path, bytes);
    if (text === null) {
      files.push({ path, binary: true, size: bytes.length });
      continue;
    }
    const total = countLines(text);
    const range = ranged ? selectLines(text, offset ?? 1, limit, total) : null;
    const content = ranged ? (range?.content ?? '') : text;
    const size = Buffer.byteLength(content, 'utf8');
    if (files.length > 0 && used + size > maxBytes) {
      omitted.push({ path, bytes: size, total_lines: total });
      continue;
    }
    used += size;
    files.push({
      path,
      content,
      total_lines: total,
      ...(ranged ? { lines: range ? { from: range.from, to: range.to } : null } : {}),
    });
  }
  return { kind: 'files', version: version.number, untrusted: true, files, omitted, missing, max_bytes: maxBytes };
}
