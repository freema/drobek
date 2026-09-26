/**
 * Guard (NSO-347): the dashboard never decides anything by the NAME of a
 * built-in module. A replacement module (same capability, another package)
 * or a third-party module must get the same page: dedicated editors follow
 * `dashboard.editor`, the Data / Forms / Users / Uploads tabs follow the
 * authorities (`records`, `submissions`, `endUsers`, `files`). So, across
 * packages/dashboard/src (tests excluded, comments ignored):
 *
 *  1. no string literal `'data'` / `'proxy'` at all (the two names the
 *     dedicated editors used to be wired to);
 *  2. no comparison, `case` or runtime lookup against any built-in module
 *     name (`name === 'auth'`, `case 'forms':`, `runtime.get('files')`,
 *     `moduleView(app, 'email')` …).
 *
 * A line that is deliberately exempt (e.g. a tab key that is a route segment,
 * not a module name) carries `module-name-guard: allow` (with the reason) on
 * the same line or the line above.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('./', import.meta.url));
const ALLOW = 'module-name-guard: allow';
const BUILTIN = ['auth', 'data', 'email', 'files', 'forms', 'proxy'];
const NAMES = BUILTIN.join('|');
const Q = `['"\`]`;

const RULES: Array<[RegExp, string]> = [
  [new RegExp(`(${Q})(?:data|proxy)\\1`), "the literal 'data' / 'proxy'"],
  [new RegExp(`(?:===|!==|==|!=)\\s*(${Q})(?:${NAMES})\\1|(${Q})(?:${NAMES})\\2\\s*(?:===|!==|==|!=)`), 'a comparison with a built-in module name'],
  [new RegExp(`\\bcase\\s+(${Q})(?:${NAMES})\\1`), 'a case on a built-in module name'],
  [
    // A form / URL / header read by a field name ('email') is not a module lookup.
    new RegExp(
      `(?<!\\b(?:form|formData|params|searchParams|search|headers|query))\\.(?:get|has|moduleView|moduleFacts|skillInfo|configure|confirm|reject)\\(\\s*(?:[^()]*,\\s*)?(${Q})(?:${NAMES})\\1`
    ),
    'a lookup by a built-in module name',
  ],
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** The source with comments blanked (line numbers kept). */
function withoutComments(src: string): string[] {
  const blocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return blocks.split('\n').map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'));
}

interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function scan(file: string, src: string): Finding[] {
  const raw = src.split('\n');
  const code = withoutComments(src);
  const out: Finding[] = [];
  code.forEach((line, i) => {
    if (raw[i]?.includes(ALLOW) || (i > 0 && raw[i - 1]?.includes(ALLOW))) return;
    for (const [re, rule] of RULES) {
      if (re.test(line)) out.push({ file, line: i + 1, rule, text: raw[i].trim() });
    }
  });
  return out;
}

describe('the dashboard knows no built-in module by name (NSO-347)', () => {
  it('no literal data/proxy, no comparison / case / lookup by a built-in module name', () => {
    const findings = sourceFiles(SRC).flatMap((f) => scan(relative(SRC, f), readFileSync(f, 'utf8')));
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('catches the patterns it is meant to catch (and ignores comments and allowed lines)', () => {
    const bad = [
      "const DEDICATED = { data: 1 }; if (name === 'data') x();",
      "const EDITORS = ['proxy'];",
      "if (module.name === 'auth') return;",
      "switch (name) { case 'forms': break; }",
      "const m = runtime.get('files');",
      "await runtime.moduleView(app, 'email');",
      "if ('forms' !== name) return;",
    ];
    for (const line of bad) expect(scan('x.ts', line), line).not.toEqual([]);
    const fine = [
      '// the built-in `data` module — a comment',
      "/* runtime.get('auth') */ const x = 1;",
      "const url = 'https://example.com/data';",
      "const label = 'Data';",
      "form.get('email');",
      "if (c.includes('email')) note();",
      `// ${ALLOW} — a route segment, not a module name\nconst tab = 'data';`,
      `const tab = 'data'; // ${ALLOW} — a route segment`,
    ];
    for (const src of fine) expect(scan('x.ts', src), src).toEqual([]);
  });
});
