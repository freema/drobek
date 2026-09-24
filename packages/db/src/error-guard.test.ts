/**
 * Guard (NSO-333): DB errors are read and logged only through the helpers in
 * errors.ts. Since drizzle-orm 0.44 a failed query is a `DrizzleQueryError`
 * whose `code` is undefined and whose message carries the bound parameters,
 * so across every package, module and the server:
 *
 *  1. no SQLSTATE literal (`'23505'`) and no `.cause.code` read outside
 *     errors.ts — use `pgErrorCode(err)` / `isUniqueViolation(err)`;
 *  2. no raw caught error in a log call — `err.message`, `err.stack`,
 *     `String(err)` or the error object itself — use `dbErrorForLog(err)`
 *     (`{ stack: true }` for the frames).
 *
 * A line that is deliberately exempt carries `db-error-guard: allow` (with
 * the reason) on the same line or the line above.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCAN = ['packages', 'modules', 'examples', 'apps/server/server', 'apps/server/app'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.react-router', 'drizzle']);
const HELPERS = 'packages/db/src/errors.ts';
const ALLOW = 'db-error-guard: allow';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const SQLSTATE_LITERAL = /['"`](?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}['"`]/;
const CAUSE_CODE = /\.cause\??\.code\b/;

/** Start of a log call: logger.error( / log?.warn( / console.error( / log( / opts.log?.( / jobLog( … */
const LOG_CALL = /\b(?:(?:log|logger|console)\s*\??\.\s*(?:error|warn|info|debug|log)|[a-zA-Z]*[lL]og)\s*(?:\?\.)?\s*\(/g;
const ERR = String.raw`(?:err|error|e|ex|cause)`;
const RAW_IN_LOG: Array<[RegExp, string]> = [
  [new RegExp(String.raw`\b${ERR}\b(?:\s+as\s+[\w.<>{}\s:?;|]+\))?\s*\??\.\s*(?:message|stack)\b`), 'err.message / err.stack'],
  [new RegExp(String.raw`\bString\(\s*\(?\s*${ERR}\b\s*\)`), 'String(err)'],
  [new RegExp(String.raw`,\s*${ERR}\s*\)\s*$`), 'the error object as an argument'],
  [new RegExp(String.raw`(?<!\$)\{\s*${ERR}\s*[,}]|,\s*${ERR}\s*\}|\b(?:err|error)\s*:\s*${ERR}\s*[,}]`), 'the error object in the metadata'],
];

/** The text of a call from its opening parenthesis to the matching close (quotes skipped). */
function callText(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

function allowed(lines: string[], line: number): boolean {
  return (lines[line - 1] ?? '').includes(ALLOW) || (lines[line - 2] ?? '').includes(ALLOW);
}

function scan(file: string, src: string): Finding[] {
  const rel = relative(ROOT, file);
  const lines = src.split('\n');
  const found: Finding[] = [];
  if (rel !== HELPERS) {
    lines.forEach((text, i) => {
      if (allowed(lines, i + 1) || /^\s*(?:\/\/|\*)/.test(text)) return;
      if (SQLSTATE_LITERAL.test(text)) found.push({ file: rel, line: i + 1, rule: 'SQLSTATE literal — use pgErrorCode(err) / isUniqueViolation(err)', text });
      if (CAUSE_CODE.test(text)) found.push({ file: rel, line: i + 1, rule: '.cause.code read — use pgErrorCode(err)', text });
    });
  }
  for (const m of src.matchAll(LOG_CALL)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const text = callText(src, open);
    const line = lineOf(src, m.index ?? 0);
    if (allowed(lines, line)) continue;
    for (const [re, what] of RAW_IN_LOG) {
      if (re.test(text)) {
        found.push({ file: rel, line, rule: `${what} in a log call — use dbErrorForLog(err) from @drobek/db`, text: lines[line - 1].trim() });
        break;
      }
    }
  }
  return found;
}

const report = (fs: Finding[]) => fs.map((f) => `${f.file}:${f.line}  ${f.rule}\n    ${f.text.trim()}`).join('\n');

describe('DB error guard', () => {
  it('no SQLSTATE literal, .cause.code read or raw error in a log call outside @drobek/db errors.ts', () => {
    const files = SCAN.flatMap((d) => sourceFiles(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(100);
    const findings = files.flatMap((f) => scan(f, readFileSync(f, 'utf8')));
    expect(report(findings), 'read / log DB errors through @drobek/db errors.ts').toBe('');
  });

  it('catches every pattern it names', () => {
    const cases = [
      "if ((err as { code?: string }).code === '23505') return;",
      'return e?.cause?.code === x;',
      "log.error('x', { error: String((err as Error)?.message ?? err) });",
      "log.error('x', { error: (err as Error).stack });",
      "opts.log?.('x', { error: String(err) });",
      "console.error('[dashboard] x failed', err);",
      "logger.warn('x', { err });",
      "ctx.log.warn('x', {\n  app_id: id,\n  error: err.message,\n});",
      "jobLog('x', { error: error });",
      "log('x', { a: 1, e });",
    ];
    for (const c of cases) expect(scan(join(ROOT, 'packages/x/src/a.ts'), c), c).not.toEqual([]);
  });

  it('lets the helpers, domain error codes and allowed lines through', () => {
    const ok = [
      "log.error('x', { error: dbErrorForLog(err, { stack: true }) });",
      "if (isUniqueViolation(err)) throw new AppsError('slug_taken', 'taken');",
      "ctx.log.info('refused', { error: err.code });",
      "logger.warn('x', { err: serializeError(err) });",
      "// db-error-guard: allow — a CLI usage line, not an error\nconsole.error(err.message);",
      "const port = '5432';",
      "for (const e of errors) console.error(`  - ${e}`);",
    ];
    for (const c of ok) expect(scan(join(ROOT, 'packages/x/src/a.ts'), c), c).toEqual([]);
  });
});
