#!/usr/bin/env node
/**
 * doc-lint (NSO-298, part of `task check` and the CI quality job).
 *
 * Three checks, all on the files git knows about (tracked + untracked, not
 * ignored), run from the repository root:
 *
 * 1. Retired vocabulary. The pre-rebuild design (an upload pipeline with a
 *    job queue, path-based app URLs on the dashboard host, a second licence)
 *    is gone; no file may describe it as current. The terms are below in
 *    RETIRED. `docs/archive/` (history) and `CHANGELOG.md` (history) are
 *    exempt. A line that has to name a retired term on purpose (a test that
 *    asserts the term is GONE) carries the marker `doc-lint: allow` on the
 *    same line or on the line directly above it.
 * 2. The README quickstart is the SELF-HOSTING quickstart, byte for byte:
 *    the text between `<!-- quickstart:start -->` and `<!-- quickstart:end -->`
 *    must exist in both files and be identical.
 * 3. The env reference is complete: every `KEY=` in `.env.example` and
 *    `.env.production.example` (commented-out ones too) appears in
 *    `docs/SELF-HOSTING.md`.
 *
 * Exit 1 with one line per finding; exit 0 and a one-line summary otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/doc-lint.mjs';
const ALLOW_MARKER = 'doc-lint: allow';

/** [label, pattern] — case-insensitive. */
const RETIRED = [
  ['deploy_init', /deploy_init/i],
  ['deploy_commit', /deploy_commit/i],
  ['manifest upload', /manifest[ -]uploads?/i],
  ['BullMQ', /bullmq/i],
  ['/:ws/app/:slug', /\/:ws\/app\/:slug/i],
  ['static bundle', /static[ -]bundles?/i],
  ['dual license', /dual[ -]licen[cs]/i],
];

const EXEMPT_PREFIXES = ['docs/archive/'];
const EXEMPT_FILES = new Set(['CHANGELOG.md', SELF, 'pnpm-lock.yaml']);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|zip|gz|tgz|wasm)$/i;

const QUICKSTART_START = '<!-- quickstart:start -->';
const QUICKSTART_END = '<!-- quickstart:end -->';
const ENV_FILES = ['.env.example', '.env.production.example'];
const ENV_DOC = 'docs/SELF-HOSTING.md';

const findings = [];

function listFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split('\0').filter(Boolean))];
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

// ── 1. retired vocabulary ────────────────────────────────────────────────────
let scanned = 0;
for (const rel of listFiles()) {
  if (EXEMPT_FILES.has(rel) || EXEMPT_PREFIXES.some((p) => rel.startsWith(p))) continue;
  if (BINARY_EXT.test(rel)) continue;
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue; // deleted in the working tree
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue; // a directory (submodule) or unreadable
  }
  if (text.includes('\0')) continue;
  scanned += 1;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [label, re] of RETIRED) {
      if (!re.test(line)) continue;
      if (line.includes(ALLOW_MARKER) || (i > 0 && lines[i - 1].includes(ALLOW_MARKER))) continue;
      findings.push(`${rel}:${i + 1}: retired term "${label}" (describe the current design, or move the file to docs/archive/)`);
    }
  });
}

// ── 2. README quickstart == SELF-HOSTING quickstart ─────────────────────────
function quickstart(rel) {
  const text = read(rel);
  const a = text.indexOf(QUICKSTART_START);
  const b = text.indexOf(QUICKSTART_END);
  if (a < 0 || b < a) {
    findings.push(`${rel}: missing the ${QUICKSTART_START} … ${QUICKSTART_END} block`);
    return null;
  }
  return text.slice(a + QUICKSTART_START.length, b);
}
const qsReadme = quickstart('README.md');
const qsSelfHost = quickstart(ENV_DOC);
if (qsReadme !== null && qsSelfHost !== null && qsReadme !== qsSelfHost) {
  const r = qsReadme.split('\n');
  const s = qsSelfHost.split('\n');
  let i = 0;
  while (i < r.length && i < s.length && r[i] === s[i]) i += 1;
  findings.push(
    `README.md: the quickstart differs from ${ENV_DOC} (first difference at block line ${i + 1}: ` +
      `${JSON.stringify(r[i] ?? '<end>')} vs ${JSON.stringify(s[i] ?? '<end>')}) — copy it verbatim`
  );
}

// ── 3. every env key is documented ──────────────────────────────────────────
const envDoc = read(ENV_DOC);
let envKeys = 0;
for (const file of ENV_FILES) {
  const keys = new Set();
  for (const line of read(file).split('\n')) {
    const m = /^#?\s?([A-Z][A-Z0-9_]+)=/.exec(line);
    if (m) keys.add(m[1]);
  }
  for (const key of keys) {
    envKeys += 1;
    if (!new RegExp(`\\b${key}\\b`).test(envDoc)) {
      findings.push(`${ENV_DOC}: ${key} (from ${file}) is not documented — add it to the environment reference`);
    }
  }
}

if (findings.length > 0) {
  for (const f of findings) console.error(f);
  console.error(`doc-lint: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log(`doc-lint: ok (${scanned} files, quickstart in sync, ${envKeys} env keys documented)`);
