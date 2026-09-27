/**
 * NSO-340: the notice on a fresh copy's Overview page — which module settings
 * of the original were applied, which wait for the owner's confirmation and
 * which were skipped (with why and what to do). Parsed from the redirect's
 * query by duplicate-result.server.ts; renders nothing without it.
 */
import { Link } from 'react-router';

export type DuplicateSkipReason = 'not_copied' | 'not_enabled' | 'invalid';

export interface DuplicateResultView {
  /** The original's slug. */
  from: string;
  applied: string[];
  pending: { module: string; href: string }[];
  skipped: { module: string; reason: DuplicateSkipReason; href: string }[];
  /** The copy's Modules tab. */
  modulesHref: string;
  /** The same page without the notice. */
  dismissHref: string;
}

const SKIP_TEXT: Record<DuplicateSkipReason, string> = {
  not_copied:
    'not copied — its settings point at records of the original’s workspace (for example registered upstreams). Set it up with your own on the module’s page.',
  not_enabled:
    'not copied — this module is not available in this workspace. The server operator turns opt-in modules on per workspace; once it is on, set it up on the module’s page.',
  invalid: 'not copied — the original’s settings are not valid for this copy. Set the module up yourself on its page.',
};

const style = {
  box: {
    margin: '0.75rem 0 1rem',
    padding: '0.7rem 0.9rem',
    border: '1px solid #bfdbfe',
    background: '#eff6ff',
    color: '#1e3a8a',
    borderRadius: '10px',
    fontSize: '0.92rem',
  },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' },
  list: { margin: '0.5rem 0 0', paddingLeft: '1.2rem' },
  item: { margin: '0.3rem 0', overflowWrap: 'anywhere' },
  link: { color: '#1e3a8a', fontWeight: 700 },
  dismiss: { color: '#1e3a8a', fontSize: '0.85rem' },
} as const;

export function DuplicateResult({ result }: { result: DuplicateResultView | null | undefined }) {
  if (!result) return null;
  const { applied, pending, skipped } = result;
  const none = applied.length === 0 && pending.length === 0 && skipped.length === 0;
  return (
    <div role="status" style={style.box} data-testid="duplicate-result">
      <div style={style.head}>
        <strong>
          Copied from {result.from}.{' '}
          {none
            ? 'The original had no module settings to copy.'
            : skipped.length > 0
              ? 'Some module settings were not copied.'
              : pending.length > 0
                ? 'Some module settings wait for your confirmation.'
                : 'Its module settings were copied.'}
        </strong>
        <Link to={result.dismissHref} style={style.dismiss} data-testid="duplicate-result-dismiss">
          Dismiss
        </Link>
      </div>
      {none ? null : (
        <ul style={style.list}>
          {applied.length > 0 ? (
            <li style={style.item} data-testid="duplicate-result-applied">
              Applied: {applied.join(', ')}.
            </li>
          ) : null}
          {pending.map((p) => (
            <li key={`p-${p.module}`} style={style.item} data-testid="duplicate-result-pending" data-module={p.module}>
              <strong>{p.module}</strong>: waits for your confirmation — nothing of it applies until you confirm.{' '}
              <Link to={p.href} style={style.link}>
                Review {p.module} →
              </Link>
            </li>
          ))}
          {skipped.map((sk) => (
            <li key={`s-${sk.module}`} style={style.item} data-testid="duplicate-result-skipped" data-module={sk.module} data-reason={sk.reason}>
              <strong>{sk.module}</strong>: {SKIP_TEXT[sk.reason]}{' '}
              <Link to={sk.reason === 'not_enabled' ? result.modulesHref : sk.href} style={style.link}>
                {sk.reason === 'not_enabled' ? 'Open Modules →' : `Set up ${sk.module} →`}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
