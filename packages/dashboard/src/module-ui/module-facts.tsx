/**
 * A module's operator-facing facts (NSO-347), shared by the workspace Modules
 * page and the module page's "About this module": version, where it was
 * loaded from, the contract range it declares, availability, the modules it
 * requires, the slots it offers (with who contributes), its contributions to
 * other modules' slots, its limits and its own error codes. Values arrive
 * pre-shaped from `ModuleRuntime.moduleFacts` — never a path on disk, never
 * a secret.
 */
import type { ReactNode } from 'react';
import { ui } from './styles.js';

export interface SlotFact {
  name: string;
  description: string;
  unique: string | null;
  contributions: { module: string; key: string | null }[];
}

export interface ContributionFact {
  slot: string;
  host: string;
  key: string | null;
}

export interface ErrorFact {
  code: string;
  meaning: string;
  fix: string;
}

export interface LimitFact {
  name: string;
  meaning: string;
  default: number;
  /** The effective value for this workspace (its plan), when known. */
  value?: number;
}

export interface ModuleFactsData {
  version: string;
  source: string;
  contract: string | null;
  availability: string;
  requires: string[];
  slots: SlotFact[];
  contributes: ContributionFact[];
  editor: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  builtin: 'built in (a package of the server)',
  dir: 'installed by the operator (modules directory)',
};

const AVAILABILITY_LABEL: Record<string, string> = {
  default: 'every workspace',
  'opt-in': 'opt-in — only the workspaces it is enabled for',
};

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <>
      <dt style={ui.factKey}>{label}</dt>
      <dd style={{ margin: 0 }} data-testid={testId}>
        {children}
      </dd>
    </>
  );
}

/** The key → value list: version, source, contract, availability (+ the workspace's state, when given), requires, editor. */
export function ModuleFactsList({ facts, availabilityExtra }: { facts: ModuleFactsData; availabilityExtra?: ReactNode }) {
  return (
    <dl style={ui.facts}>
      <Fact label="Version" testId="fact-version">
        <code style={ui.mono}>{facts.version}</code>
      </Fact>
      <Fact label="Source" testId="fact-source">
        <span data-source={facts.source}>{SOURCE_LABEL[facts.source] ?? facts.source}</span>
      </Fact>
      <Fact label="Contract" testId="fact-contract">
        {facts.contract ? <code style={ui.mono}>{facts.contract}</code> : <span style={ui.muted}>not declared</span>}
      </Fact>
      <Fact label="Availability" testId="fact-availability">
        <span data-availability={facts.availability}>{AVAILABILITY_LABEL[facts.availability] ?? facts.availability}</span>
        {availabilityExtra}
      </Fact>
      <Fact label="Requires" testId="fact-requires">
        {facts.requires.length > 0 ? facts.requires.map((r) => <code key={r} style={{ ...ui.mono, marginRight: '0.4rem' }}>{r}</code>) : <span style={ui.muted}>nothing</span>}
      </Fact>
      {facts.editor ? (
        <Fact label="Dashboard editor" testId="fact-editor">
          <code style={ui.mono}>{facts.editor}</code>
        </Fact>
      ) : null}
    </dl>
  );
}

/** The slots a module offers and who contributes to each. */
export function SlotsTable({ slots }: { slots: SlotFact[] }) {
  if (slots.length === 0) return null;
  return (
    <div style={ui.tableWrap}>
      <table style={ui.table} data-testid="slots-table">
        <thead>
          <tr>
            <th style={ui.th}>Slot it offers</th>
            <th style={ui.th}>What a contribution does</th>
            <th style={ui.th}>Contributed by</th>
          </tr>
        </thead>
        <tbody>
          {slots.map((s) => (
            <tr key={s.name} data-testid="slot-row" data-slot={s.name}>
              <td style={ui.td}>
                <code style={ui.mono}>{s.name}</code>
                {s.unique ? <div style={ui.small}>unique by {s.unique}</div> : null}
              </td>
              <td style={ui.td}>{s.description}</td>
              <td style={ui.td}>
                {s.contributions.length === 0 ? (
                  <span style={ui.muted}>nobody yet</span>
                ) : (
                  s.contributions.map((c) => (
                    <div key={`${c.module}-${c.key ?? ''}`}>
                      <code style={ui.mono}>{c.module}</code>
                      {c.key !== null ? <span style={ui.small}> ({s.unique}: {c.key})</span> : null}
                    </div>
                  ))
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A module's contributions to other modules' slots. */
export function ContributesTable({ contributes }: { contributes: ContributionFact[] }) {
  if (contributes.length === 0) return null;
  return (
    <div style={ui.tableWrap}>
      <table style={ui.table} data-testid="contributes-table">
        <thead>
          <tr>
            <th style={ui.th}>Contributes to</th>
            <th style={ui.th}>Of module</th>
            <th style={ui.th}>As</th>
          </tr>
        </thead>
        <tbody>
          {contributes.map((c) => (
            <tr key={`${c.slot}-${c.key ?? ''}`} data-testid="contributes-row" data-slot={c.slot}>
              <td style={ui.td}>
                <code style={ui.mono}>{c.slot}</code>
              </td>
              <td style={ui.td}>
                <code style={ui.mono}>{c.host}</code>
              </td>
              <td style={ui.td}>{c.key !== null ? <code style={ui.mono}>{c.key}</code> : <span style={ui.muted}>—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The limits a module declares, with the value in force for the workspace. */
export function LimitsTable({ limits }: { limits: LimitFact[] }) {
  if (limits.length === 0) return null;
  return (
    <div style={ui.tableWrap}>
      <table style={ui.table} data-testid="limits-table">
        <thead>
          <tr>
            <th style={ui.th}>Limit</th>
            <th style={ui.th}>Meaning</th>
            <th style={ui.th}>This workspace</th>
          </tr>
        </thead>
        <tbody>
          {limits.map((l) => (
            <tr key={l.name} data-testid="limit-row" data-limit={l.name}>
              <td style={ui.td}>
                <code style={ui.mono}>{l.name}</code>
              </td>
              <td style={ui.td}>{l.meaning}</td>
              <td style={ui.td}>
                <strong data-testid="limit-value">{l.value ?? l.default}</strong>
                {l.value !== undefined && l.value !== l.default ? <span style={ui.small}> (server default {l.default})</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A module's own error codes: what an agent (or the app's code) may see, what it means, what to do. */
export function ErrorsTable({ errors }: { errors: ErrorFact[] }) {
  if (errors.length === 0) return <p style={ui.small}>No error codes of its own — only the core ones.</p>;
  return (
    <div style={ui.tableWrap}>
      <table style={ui.table} data-testid="errors-table">
        <thead>
          <tr>
            <th style={ui.th}>Code</th>
            <th style={ui.th}>Meaning</th>
            <th style={ui.th}>Fix</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((e) => (
            <tr key={e.code} data-testid="error-row" data-code={e.code}>
              <td style={ui.td}>
                <code style={ui.mono}>{e.code}</code>
              </td>
              <td style={ui.td}>{e.meaning}</td>
              <td style={ui.td}>{e.fix}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
