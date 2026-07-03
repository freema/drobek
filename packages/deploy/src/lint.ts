/**
 * Strict deploy lint (U6, PHY-57) — a SECURITY control, not a style check.
 *
 * HARD RULE: a deployed static app must never ship headless-browser automation
 * (chromium/puppeteer/playwright/headless) — that is an abuse vector on the
 * shared host. Any reference in an html/css/js file is a BLOCKING error and the
 * worker refuses to activate the deploy. Everything else is a non-blocking
 * warning. The worker recomputes this over the STORED bytes — never the client
 * manifest — so a lying client cannot smuggle content past the gate.
 */

const LINTABLE_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.css',
]);

/** Headless-browser automation tooling — blocked outright. */
const BLOCKED_REFERENCE = /\b(chromium|puppeteer|playwright|headless)\b/i;

export interface LintFinding {
  path: string;
  rule: string;
  message: string;
}

export interface LintReport {
  ok: boolean;
  /** Blocking — a non-empty list means the deploy is rejected. */
  errors: LintFinding[];
  /** Non-blocking advisories. */
  warnings: LintFinding[];
}

function extname(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i).toLowerCase() : '';
}

/** True when a path's bytes should be scanned (html/css/js family). */
export function isLintable(path: string): boolean {
  return LINTABLE_EXTENSIONS.has(extname(path));
}

/** Lint a single file's content — pure. */
export function lintFile(
  path: string,
  content: string
): { errors: LintFinding[]; warnings: LintFinding[] } {
  const errors: LintFinding[] = [];
  const warnings: LintFinding[] = [];

  const blocked = BLOCKED_REFERENCE.exec(content);
  if (blocked) {
    errors.push({
      path,
      rule: 'no-headless-browser',
      message: `references "${blocked[1]}" — headless-browser automation (chromium/puppeteer/playwright/headless) is not permitted`,
    });
  }

  const ext = extname(path);
  if (
    (ext === '.html' || ext === '.htm') &&
    !/<!doctype/i.test(content) &&
    !/<html[\s>]/i.test(content)
  ) {
    warnings.push({
      path,
      rule: 'html-sanity',
      message: 'no <!doctype> or <html> element found',
    });
  }

  return { errors, warnings };
}

/** Aggregate the per-file findings into a report (ok ⇔ no blocking errors). */
export function lintFiles(
  files: { path: string; content: string }[]
): LintReport {
  const errors: LintFinding[] = [];
  const warnings: LintFinding[] = [];
  for (const f of files) {
    const r = lintFile(f.path, f.content);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** One-line actionable summary for the deploys.error column. */
export function lintErrorSummary(report: LintReport): string {
  if (report.errors.length === 0) return '';
  const first = report.errors[0];
  const more =
    report.errors.length > 1 ? ` (+${report.errors.length - 1} more)` : '';
  return `lint blocked: ${first.path}: ${first.message}${more}`;
}
