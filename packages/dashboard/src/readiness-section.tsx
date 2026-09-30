/**
 * "Before you publish" — the publish readiness report of the app's
 * newest version on the Overview tab, the same report the agent gets from
 * write_files and publish. Compile errors block; warnings are advice and
 * never stop the Publish button. Feed it `loadReadiness()`'s view; renders
 * nothing when the app has no version yet. The background TypeScript check
 * adds `type_error` warnings once done; while it runs, or when it
 * hit a server limit, a note says so.
 */
import type { CSSProperties } from 'react';
import type { ReadinessFinding } from '@drobek/compile';
import type { ReadinessView } from './readiness.server.js';

const style = {
  box: {
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    padding: '0.8rem 1rem',
    background: '#fcfcfd',
    marginTop: '0.5rem',
    fontSize: '0.92rem',
  },
  okBox: { borderColor: '#bbf7d0', background: '#f0fdf4', color: '#14532d' },
  warnBox: { borderColor: '#fde68a', background: '#fffbeb', color: '#78350f' },
  errBox: { borderColor: '#fecaca', background: '#fef2f2', color: '#7f1d1d' },
  lead: { margin: 0 },
  list: { margin: '0.6rem 0 0', padding: 0, listStyle: 'none' },
  item: { padding: '0.45rem 0', borderTop: '1px solid rgba(0,0,0,0.06)', overflowWrap: 'anywhere' },
  code: { fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem', fontWeight: 700 },
  place: { fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem', color: '#52525b' },
  hint: { fontSize: '0.84rem', color: '#3f3f46', marginTop: '0.2rem' },
  h2: { fontSize: '1.15rem', marginTop: '2.25rem', marginBottom: '0.5rem' },
} satisfies Record<string, CSSProperties>;

function Finding({ f, kind }: { f: ReadinessFinding; kind: 'blocking' | 'warning' }) {
  return (
    <li style={style.item} data-testid={`readiness-${kind}`} data-code={f.code}>
      <span style={style.code}>{f.code}</span>
      {f.file ? (
        <span style={style.place}>
          {' '}
          · {f.file}
          {f.line ? `:${f.line}` : ''}
        </span>
      ) : null}
      {/* React escapes the message: a compile error quotes app source. */}
      <div>{f.message}</div>
      <div style={style.hint}>How to fix: {f.hint}</div>
    </li>
  );
}

export function ReadinessSection({ readiness }: { readiness: ReadinessView | null }) {
  if (!readiness) return null;
  const v = `v${readiness.version}`;
  let body;
  let tone: CSSProperties;
  if (readiness.state === 'error') {
    tone = style.errBox;
    body = (
      <p style={style.lead}>
        The publish check for {v} could not be loaded. Publishing still works; reload the page to run the check again.
      </p>
    );
  } else {
    const { ready, blocking, warnings, warnings_omitted: omitted = 0, typecheck } = readiness.report;
    const more = omitted > 0 ? <p style={{ ...style.lead, marginTop: '0.5rem' }}>…and {omitted} more.</p> : null;
    const typeNote =
      ready && typecheck === 'pending' ? (
        <p style={{ ...style.lead, marginTop: '0.5rem' }} data-testid="readiness-typecheck">
          The TypeScript check of {v} is still running. Reload the page in a few seconds to see any type errors.
        </p>
      ) : ready && typecheck === 'unavailable' ? (
        <p style={{ ...style.lead, marginTop: '0.5rem' }} data-testid="readiness-typecheck">
          The TypeScript check of {v} did not finish within this server&apos;s limits, so type errors are not listed.
        </p>
      ) : null;
    if (!ready) {
      tone = style.errBox;
      body = (
        <>
          <p style={style.lead}>
            <strong>{v} did not build, so it cannot be published.</strong> Ask your agent to fix the errors below — its next
            write creates a new version, and this check runs again.
          </p>
          <ul style={style.list}>
            {blocking.map((f, i) => (
              <Finding key={`b${i}`} f={f} kind="blocking" />
            ))}
          </ul>
        </>
      );
    } else if (warnings.length > 0) {
      tone = style.warnBox;
      const n = warnings.length + omitted;
      body = (
        <>
          <p style={style.lead}>
            <strong>
              {v} can be published, with {n} {n === 1 ? 'thing' : 'things'} worth fixing first.
            </strong>{' '}
            These never block Publish. Ask your agent to fix them; it sees the same list after every write.
          </p>
          <ul style={style.list}>
            {warnings.map((f, i) => (
              <Finding key={`w${i}`} f={f} kind="warning" />
            ))}
          </ul>
          {more}
          {typeNote}
        </>
      );
    } else {
      tone = style.okBox;
      body = (
        <>
          <p style={style.lead}>
            {v} passed every publish check. Publish it from the version list below when you are ready.
          </p>
          {typeNote}
        </>
      );
    }
  }
  const state = readiness.state === 'error' ? 'error' : readiness.report.ready ? (readiness.report.warnings.length > 0 ? 'warnings' : 'ready') : 'blocked';
  return (
    <section aria-labelledby="readiness-heading" data-testid="readiness-section" data-state={state} data-version={readiness.version}>
      <h2 id="readiness-heading" style={style.h2}>
        Before you publish
      </h2>
      <div role="status" style={{ ...style.box, ...tone }}>
        {body}
      </div>
    </section>
  );
}
