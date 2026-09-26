/**
 * The workspace Modules page's module list (NSO-347): one card per active
 * platform module — its facts (version, source, contract, availability,
 * requires), the slots it offers and who contributes, its own contributions,
 * its limits for this workspace and its error codes.
 *
 * `availabilityControls` is the mount point for the per-workspace enable
 * toggle of an opt-in module (a super-admin control): whatever it renders
 * appears next to the module's availability.
 */
import type { ReactNode } from 'react';
import { ContributesTable, ErrorsTable, LimitsTable, ModuleFactsList, SlotsTable, type ErrorFact, type LimitFact, type ModuleFactsData } from './module-facts.js';
import { ui } from './styles.js';

/** One module as the workspace Modules page shows it. */
export interface WorkspaceModule extends ModuleFactsData {
  name: string;
  useWhen: string;
  limits: LimitFact[];
  errors: ErrorFact[];
}

const styles = {
  list: { listStyle: 'none', padding: 0, margin: '1.25rem 0' },
  card: { border: '1px solid #e4e4e7', borderRadius: '10px', padding: '0.9rem 1rem', marginBottom: '0.9rem' },
  head: { display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' },
  name: { fontSize: '1.05rem', fontWeight: 700, margin: 0 },
  h3: { fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#555', margin: '0.9rem 0 0.2rem' },
} as const;

export function WorkspaceModules({
  modules,
  availabilityControls,
}: {
  modules: readonly WorkspaceModule[];
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
  return (
    <ul style={styles.list} data-testid="workspace-modules">
      {modules.map((m) => (
        <li key={m.name} id={`module-${m.name}`} style={styles.card} data-testid="workspace-module" data-module={m.name}>
          <div style={styles.head}>
            <h2 style={styles.name}>{m.name}</h2>
            <span style={m.availability === 'opt-in' ? ui.warnBadge : ui.badge} data-testid="module-availability">
              {m.availability}
            </span>
            <span style={ui.badge} data-testid="module-source">
              {m.source}
            </span>
          </div>
          {m.useWhen ? <p style={{ ...ui.hint, margin: '0.3rem 0 0' }}>Use when {m.useWhen}</p> : null}
          <ModuleFactsList facts={m} availabilityExtra={availabilityControls?.(m)} />
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
          {m.limits.length > 0 ? (
            <>
              <h3 style={styles.h3}>Limits</h3>
              <LimitsTable limits={m.limits} />
            </>
          ) : null}
          <h3 style={styles.h3}>Error codes</h3>
          <ErrorsTable errors={m.errors} />
        </li>
      ))}
    </ul>
  );
}

