/**
 * The workspace Modules page's module list: a search (a GET form,
 * works without client JS), a jump list, then one card per active platform
 * module — what it is for, its version, availability (+ the opt-in switch)
 * and requirements up front; its limits for this workspace and the technical
 * facts (source, contract, slots, contributions, error codes) in collapsed
 * sections.
 *
 * `availabilityControls` is the mount point for the per-workspace enable
 * toggle of an opt-in module (a super-admin control): whatever it renders
 * appears next to the module's availability.
 */
import type { ReactNode } from 'react';
import { Form, Link } from 'react-router';
import { filterModules, moduleHeading, moduleSummary } from '../module-catalogue.js';
import { ContributesTable, Disclosure, ErrorsTable, LimitsTable, ModuleFactsList, SlotsTable, type ErrorFact, type LimitFact, type ModuleFactsData } from './module-facts.js';
import { ui } from './styles.js';

/** One module as the workspace Modules page shows it. */
export interface WorkspaceModule extends ModuleFactsData {
  name: string;
  useWhen: string;
  /** `dashboard.title` / `dashboard.description` (null or absent without). */
  title?: string | null;
  description?: string | null;
  limits: LimitFact[];
  errors: ErrorFact[];
}

const styles = {
  list: { listStyle: 'none', padding: 0, margin: '1rem 0' },
  card: { border: '1px solid #e4e4e7', borderRadius: '10px', padding: '0.9rem 1rem', marginBottom: '0.9rem', minWidth: 0 },
  head: { display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' },
  name: { fontSize: '1.05rem', fontWeight: 700, margin: 0, overflowWrap: 'anywhere' },
  h3: { fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#555', margin: '0.9rem 0 0.2rem' },
  search: { display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap', margin: '1.25rem 0 0.5rem' },
  searchField: { flex: '1 1 14rem', minWidth: 0, maxWidth: '28rem' },
  jump: { display: 'flex', flexWrap: 'wrap', gap: '0.35rem 0.8rem', margin: '0.4rem 0 0', padding: 0, listStyle: 'none', fontSize: '0.88rem' },
} as const;

function ModuleCard({ m, availabilityControls }: { m: WorkspaceModule; availabilityControls?: (module: WorkspaceModule) => ReactNode }) {
  const technical = m.slots.length + m.contributes.length;
  return (
    <li id={`module-${m.name}`} style={styles.card} data-testid="workspace-module" data-module={m.name}>
      <div style={styles.head}>
        <h2 style={styles.name}>{moduleHeading(m)}</h2>
        <span style={m.availability === 'opt-in' ? ui.warnBadge : ui.badge} data-testid="module-availability">
          {m.availability}
        </span>
        <span style={ui.badge} data-testid="module-source">
          {m.source}
        </span>
      </div>
      {moduleSummary(m) ? <p style={{ ...ui.hint, margin: '0.3rem 0 0' }}>{moduleSummary(m)}</p> : null}
      <ModuleFactsList facts={m} part="summary" availabilityExtra={availabilityControls?.(m)} />
      {m.limits.length > 0 ? (
        <Disclosure testId="module-limits" summary={`Limits for this workspace (${m.limits.length})`}>
          <LimitsTable limits={m.limits} />
        </Disclosure>
      ) : null}
      <Disclosure
        testId="module-technical"
        summary={`Technical details — source, contract${technical > 0 ? ', slots' : ''}, error codes (${m.errors.length})`}
      >
        <ModuleFactsList facts={m} part="technical" />
        {m.slots.length > 0 ? (
          <>
            <h3 style={styles.h3}>Slots</h3>
            <SlotsTable slots={m.slots} />
          </>
        ) : null}
        {m.contributes.length > 0 ? (
          <>
            <h3 style={styles.h3}>Contributions</h3>
            <ContributesTable contributes={m.contributes} />
          </>
        ) : null}
        <h3 style={styles.h3}>Error codes</h3>
        <ErrorsTable errors={m.errors} />
      </Disclosure>
    </li>
  );
}

export function WorkspaceModules({
  modules,
  query = '',
  availabilityControls,
}: {
  modules: readonly WorkspaceModule[];
  /** The search (`?q=`): every word must appear in the name, "use when", a slot or a limit. */
  query?: string;
  /** Rendered next to each module's availability (the opt-in enable toggle mounts here). */
  availabilityControls?: (module: WorkspaceModule) => ReactNode;
}) {
  if (modules.length === 0) {
    return (
      <p style={ui.muted} data-testid="modules-empty">
        This server runs no platform modules: apps here are self-contained front-ends.
      </p>
    );
  }
  const q = query.trim();
  const shown = filterModules(modules, q);
  return (
    <>
      {/* Keyed by the query: the uncontrolled input follows the URL on "Show all" and back/forward. */}
      <Form key={query} method="get" role="search" style={styles.search} data-testid="modules-search">
        <div style={styles.searchField}>
          <label htmlFor="modules-q" style={ui.label}>
            Search modules
          </label>
          <input
            id="modules-q"
            type="search"
            name="q"
            defaultValue={q}
            placeholder="e.g. sign-in, upload, limit name"
            style={ui.input}
            data-testid="modules-search-input"
          />
        </div>
        <button type="submit" style={ui.secondaryButton} data-testid="modules-search-submit">
          Search
        </button>
        {q ? (
          <Link to={{ search: '' }} style={{ fontSize: '0.9rem' }} data-testid="modules-search-clear">
            Show all {modules.length}
          </Link>
        ) : null}
      </Form>
      {shown.length === 0 ? (
        <p style={ui.muted} role="status" data-testid="modules-no-match">
          No module matches “{q}”. Try another word, or{' '}
          <Link to={{ search: '' }}>show all {modules.length} modules</Link>.
        </p>
      ) : (
        <>
          <nav aria-label="Modules on this page">
            <p style={{ ...ui.small, margin: 0 }} role="status" data-testid="modules-count">
              {q ? `${shown.length} of ${modules.length} modules match “${q}”.` : `${modules.length} modules.`} Jump to:
            </p>
            <ul style={styles.jump}>
              {shown.map((m) => (
                <li key={m.name}>
                  <a href={`#module-${m.name}`} data-testid="modules-jump">
                    {moduleHeading(m)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <ul style={styles.list} data-testid="workspace-modules">
            {shown.map((m) => (
              <ModuleCard key={m.name} m={m} availabilityControls={availabilityControls} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
