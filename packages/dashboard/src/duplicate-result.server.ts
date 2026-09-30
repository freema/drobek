/**
 * What happened to the module settings of a fresh copy, carried from
 * /duplicate/:slug to the copy's Overview page in the redirect's query
 * (`duplicated`, `applied`, `pending`, `skipped=<module>:<reason>`). The query
 * is visitor-editable, so the parse keeps only well-formed module names and
 * known reasons; it only ever labels the page, it grants nothing.
 */
import { MODULE_NAME_RE, type DuplicateConfigsResult } from '@drobek/modules';
import type { DuplicateResultView, DuplicateSkipReason } from './duplicate-result.js';

const REASONS: readonly DuplicateSkipReason[] = ['not_copied', 'not_enabled', 'invalid'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The copy's Overview URL with the outcome in its query. */
export function duplicatedAppUrl(appPath: string, sourceSlug: string, modules: DuplicateConfigsResult): string {
  const q = new URLSearchParams({ duplicated: sourceSlug });
  if (modules.applied.length > 0) q.set('applied', modules.applied.join(','));
  if (modules.pending.length > 0) q.set('pending', modules.pending.map((p) => p.module).join(','));
  if (modules.skipped.length > 0) q.set('skipped', modules.skipped.map((s) => `${s.module}:${s.reason}`).join(','));
  return `${appPath}?${q.toString()}`;
}

function names(raw: string | null): string[] {
  return [...new Set((raw ?? '').split(',').filter((m) => MODULE_NAME_RE.test(m)))];
}

/** The outcome in `url`'s query, or null when the page was not opened right after a duplicate. */
export function parseDuplicateResult(url: URL, modulesPath: string): DuplicateResultView | null {
  const from = url.searchParams.get('duplicated') ?? '';
  if (!SLUG_RE.test(from)) return null;
  const skipped: DuplicateResultView['skipped'] = [];
  for (const entry of (url.searchParams.get('skipped') ?? '').split(',')) {
    const [module = '', reason = ''] = entry.split(':');
    if (MODULE_NAME_RE.test(module) && (REASONS as readonly string[]).includes(reason)) {
      skipped.push({ module, reason: reason as DuplicateSkipReason, href: `${modulesPath}/${module}` });
    }
  }
  return {
    from,
    applied: names(url.searchParams.get('applied')),
    pending: names(url.searchParams.get('pending')).map((module) => ({ module, href: `${modulesPath}/${module}` })),
    skipped,
    modulesHref: modulesPath,
    dismissHref: url.pathname,
  };
}
