/**
 * The version history of the app page's Overview tab:
 *
 *  - the result banner of a keep / unkeep / clean-up;
 *  - "Pinned": the live, preview and kept versions, one row per version
 *    whatever page of the history is shown;
 *  - "History": one page of versions, newest first, where pinned versions
 *    carry their badges too and 2+ failed builds in a row collapse into one
 *    "N failed builds" row; "Show older versions" / "Newest versions" page
 *    through it (`?before=`);
 *  - "Clean up history" (editor+, not on a taken-down app): a GET form opens
 *    the confirm panel (`?cleanup=<N>[&failedOnly=1]`, works without
 *    JavaScript) that says what goes and why the rest stays; only its POST
 *    (`intent=delete-versions`, `confirmed=1`, the plan's `planId`) deletes,
 *    and only while what goes is still that plan.
 *
 * Per version: number, author, build (+ the first error), the agent's note,
 * time, and — editor+ only — Publish (a compiled, unpublished version; an
 * older one IS the rollback), Restore (a NEW version with its files becomes
 * the preview), Keep / Unkeep; Open links to `<slug>--v<N>` (a link, never a
 * frame), Files to the version's files. A viewer sees the badges only.
 */
import type { ReactNode } from 'react';
import { Form, Link, useLocation, useNavigation } from 'react-router';
import type { loader } from './routes/workspaces.$slug.apps.$appSlug.server.js';
import { appStyles } from './app-header.js';
import { rangeLabel, type VersionResult } from './version-history.js';
import { formatTimestamp } from './view.js';

type Data = Awaited<ReturnType<typeof loader>>;
type Version = Data['pinned'][number];

const s = appStyles;

const styles = {
  visuallyHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  },
  h2: { fontSize: '1.15rem', marginTop: '2.25rem', marginBottom: '0.5rem' },
  h3: { fontSize: '0.95rem', marginTop: '1.5rem', marginBottom: '0.4rem' },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' },
  muted: { color: '#8a8a8e' },
  note: { color: '#8a8a8e', fontSize: '0.85rem', marginTop: 0 },
  firstError: { fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', color: '#991b1b', wordBreak: 'break-word' },
  previewBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#1e3a8a',
    background: '#dbeafe',
    border: '1px solid #bfdbfe',
  },
  keptBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#78350f',
    background: '#fef3c7',
    border: '1px solid #fde68a',
  },
  ok: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#166534',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    marginTop: '1rem',
  },
  warn: {
    background: '#fffbeb',
    border: '1px solid #fde68a',
    color: '#78350f',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    marginTop: '1rem',
  },
  pager: { display: 'flex', gap: '1rem', alignItems: 'baseline', flexWrap: 'wrap', marginTop: '0.6rem', fontSize: '0.88rem' },
  runList: { listStyle: 'none', padding: 0, margin: '0.5rem 0 0' },
  runItem: { padding: '0.35rem 0', borderTop: '1px solid #f0f0f2', fontSize: '0.85rem' },
  confirm: {
    border: '1px solid #fecaca',
    background: '#fffafa',
    borderRadius: '10px',
    padding: '0.9rem 1rem',
    marginTop: '0.75rem',
    outline: 'none',
  },
  confirmH: { fontSize: '1rem', margin: '0 0 0.4rem' },
  stays: { margin: '0.4rem 0 0.6rem', paddingLeft: '1.2rem', fontSize: '0.88rem' },
} as const;

const COMPILE_LABEL: Record<string, string> = {
  ok: 'build succeeded',
  error: 'build failed',
  pending: 'not built',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Live / Preview / Kept. `prefix` keeps the history's test ids apart from the pinned table's. */
function Badges({ v, prefix }: { v: Version; prefix: 'version' | 'pinned' }) {
  return (
    <>
      {v.published ? (
        <span style={s.okBadge} data-testid={prefix === 'version' ? 'version-published' : 'pinned-badge'} data-kind="live">
          live
        </span>
      ) : null}{' '}
      {v.preview ? (
        <span style={styles.previewBadge} data-testid={`${prefix}-${prefix === 'version' ? 'preview' : 'badge'}`} data-kind="preview">
          preview
        </span>
      ) : null}{' '}
      {v.kept ? (
        <span style={styles.keptBadge} data-testid={`${prefix}-${prefix === 'version' ? 'kept' : 'badge'}`} data-kind="kept">
          kept
        </span>
      ) : null}
    </>
  );
}

function KeepButton({ v, keep, busy }: { v: Version; keep: number; busy: boolean }) {
  const { pathname, search } = useLocation();
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={v.kept ? 'unkeep' : 'keep'} />
      <input type="hidden" name="version" value={v.number} />
      <input type="hidden" name="redirectTo" value={`${pathname}${search}`} />
      <button
        type="submit"
        style={s.secondaryButton}
        disabled={busy}
        title={
          v.kept
            ? `Stop keeping v${v.number}. Once it is older than the newest ${keep} versions and nothing else protects it, the hourly retention deletes it.`
            : `Keep v${v.number}: the hourly retention and a clean-up never delete it.`
        }
        data-testid="keep-button"
        data-version={v.number}
        data-kept={v.kept ? 'true' : 'false'}
      >
        {v.kept ? 'Unkeep' : 'Keep'}
      </button>
    </Form>
  );
}

function BuildCell({ v }: { v: Version }) {
  return (
    <>
      {COMPILE_LABEL[v.compileStatus]}
      {v.compileErrorCount > 0 ? ` (${v.compileErrorCount})` : ''}
      {/* React escapes the compiler's message (it quotes app source). */}
      {v.compileFirstError ? <div style={styles.firstError}>{v.compileFirstError}</div> : null}
    </>
  );
}

function ResultBanner({ result, keep, keptMax }: { result: VersionResult | null; keep: number; keptMax: number }) {
  if (!result) return null;
  if (result.kind === 'kept') {
    return (
      <p style={styles.ok} role="status" data-testid="version-result" data-kind="kept">
        v{result.number} is kept: the hourly retention and a clean-up leave it alone. An app keeps up to {keptMax} versions; unkeep
        one when you no longer need it.
      </p>
    );
  }
  if (result.kind === 'unkept') {
    return result.prunable ? (
      <p style={styles.warn} role="status" data-testid="version-result" data-kind="unkept" data-prunable="true">
        You stopped keeping v{result.number}. It is older than the newest {keep} versions and nothing else protects it, so the
        hourly history retention will delete it. Keep it again if you still need it, or download its ZIP from its Files page.
      </p>
    ) : (
      <p style={styles.ok} role="status" data-testid="version-result" data-kind="unkept" data-prunable="false">
        You stopped keeping v{result.number}. It stays while it is live, the preview, among the newest {keep} versions or from the
        last hour.
      </p>
    );
  }
  const stayed = result.stayed > 0 ? ` ${plural(result.stayed, 'version')} stayed because they are protected.` : '';
  return result.count > 0 ? (
    <p style={styles.ok} role="status" data-testid="version-result" data-kind="deleted" data-count={result.count}>
      Deleted {plural(result.count, result.failedOnly ? 'failed build' : 'version')} for good
      {result.ranges.length > 0 ? ` (${rangeLabel(result.ranges)})` : ''}. Their storage no longer counts toward the workspace&apos;s
      quota.{stayed}
    </p>
  ) : (
    <p style={styles.warn} role="status" data-testid="version-result" data-kind="deleted" data-count={0}>
      Nothing was deleted: by the time you confirmed, no version in that range could go any more. Review the clean-up again to
      see what stays.{stayed}
    </p>
  );
}

function VersionTable({
  rows,
  prefix,
  children,
}: {
  rows: number;
  prefix: 'version-history' | 'pinned-versions';
  children: ReactNode;
}) {
  return (
    <div style={s.tableWrap}>
      <table style={s.table} className="dk-cards dk-versions" data-testid={prefix} data-rows={rows}>
        <thead>
          <tr>
            <th style={s.th}>Version</th>
            <th style={s.th}>By</th>
            <th style={s.th}>Build</th>
            <th style={s.th}>Note</th>
            <th style={s.th}>Created</th>
            <th style={s.th}>
              <span style={styles.visuallyHidden}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function CommonCells({ v, prefix }: { v: Version; prefix: 'version' | 'pinned' }) {
  return (
    <>
      <td style={s.td} data-cell="version">
        <code style={styles.mono}>v{v.number}</code> <Badges v={v} prefix={prefix} />
      </td>
      <td style={s.td} data-cell="by" data-label="By">
        {v.actorKind}
        {v.author ? <div style={{ ...styles.muted, fontSize: '0.78rem' }}>{v.author}</div> : null}
      </td>
      <td style={s.td} data-cell="build" data-label="Build" data-testid={`${prefix}-compile`} data-status={v.compileStatus}>
        <BuildCell v={v} />
      </td>
      {/* React escapes the agent-supplied reasoning. */}
      <td style={s.td} data-cell="note" data-label="Note">
        {v.reasoning ?? <span style={styles.muted}>—</span>}
      </td>
      <td style={s.td} data-cell="created" data-label="Created">
        {formatTimestamp(v.createdAt)}
      </td>
    </>
  );
}

export function VersionHistorySection({ data }: { data: Data }) {
  const { header, pinned, history, paging, retention, versionResult, cleanup, cleanupError, canPublish, canKeep, canClean } = data;
  const busy = useNavigation().state !== 'idle';
  const base = header.basePath;
  const shown = history.reduce((n, e) => n + (e.kind === 'version' ? 1 : e.items.length), 0);

  return (
    <>
      <h2 style={styles.h2}>Versions</h2>
      <ResultBanner result={versionResult} keep={retention.keep} keptMax={retention.keptMax} />
      {retention.stored > 0 ? (
        <p style={styles.note} data-testid="version-retention" data-keep={retention.keep}>
          drobek keeps the newest {retention.keep} versions of this app, plus the live version, the preview, the kept versions and
          those kept for a rollback; the hourly retention deletes older ones. {retention.stored}{' '}
          {retention.stored === 1 ? 'version is' : 'versions are'} stored now
          {retention.oldest !== null ? `, the oldest is v${retention.oldest}` : ''}. Keep a version to protect it (up to{' '}
          {retention.keptMax}), or download its ZIP from its Files page.
        </p>
      ) : null}

      {pinned.length > 0 ? (
        <>
          <h3 style={styles.h3}>Pinned</h3>
          <p style={styles.note}>The live version, the preview and the kept versions, whichever page of the history you look at.</p>
          <VersionTable rows={pinned.length} prefix="pinned-versions">
            {pinned.map((v) => (
              <tr key={v.id} data-testid="pinned-row" data-version={v.number}>
                <CommonCells v={v} prefix="pinned" />
                <td style={s.td} data-cell="actions">
                  <span style={{ ...s.inline, flexWrap: 'nowrap', overflowWrap: 'normal' }}>
                    {canKeep ? <KeepButton v={v} keep={retention.keep} busy={busy} /> : null}
                    {v.openUrl ? (
                      <a href={v.openUrl} target="_blank" rel="noopener noreferrer" data-testid="pinned-open-link" data-version={v.number}>
                        Open
                      </a>
                    ) : null}
                    <Link to={`${base}/files?version=${v.number}`} data-testid="pinned-files-link" data-version={v.number}>
                      Files
                    </Link>
                  </span>
                </td>
              </tr>
            ))}
          </VersionTable>
        </>
      ) : null}

      {retention.stored === 0 ? (
        <p style={styles.muted} data-testid="versions-empty">
          No versions yet — your agent writes the first one.
        </p>
      ) : shown === 0 ? (
        <p style={styles.muted} data-testid="versions-past-end">
          There are no versions older than v{paging.before}.{' '}
          <Link to={base} data-testid="versions-newest">
            Show the newest versions
          </Link>
        </p>
      ) : (
        <>
          <h3 style={styles.h3}>History</h3>
          <VersionTable rows={shown} prefix="version-history">
            {history.map((e) =>
              e.kind === 'failedRun' ? (
                <tr key={`run-${e.to}`} data-testid="failed-run" data-from={e.from} data-to={e.to}>
                  <td style={s.td} colSpan={6}>
                    <details>
                      <summary data-testid="failed-run-summary">
                        {plural(e.items.length, 'failed build')}, v{e.from}–v{e.to}
                      </summary>
                      <ul style={styles.runList}>
                        {e.items.map((v) => (
                          <li key={v.id} style={styles.runItem} data-testid="failed-run-version" data-version={v.number}>
                            <code style={styles.mono}>v{v.number}</code> · {formatTimestamp(v.createdAt)} · {v.actorKind}
                            {v.reasoning ? ` · ${v.reasoning}` : ''}{' '}
                            <Link to={`${base}/files?version=${v.number}`} data-testid="failed-run-files-link" data-version={v.number}>
                              Files
                            </Link>
                            {canKeep ? (
                              <span style={{ display: 'inline-block', marginLeft: '0.5rem' }}>
                                <KeepButton v={v} keep={retention.keep} busy={busy} />
                              </span>
                            ) : null}
                            {v.compileFirstError ? <div style={styles.firstError}>{v.compileFirstError}</div> : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </td>
                </tr>
              ) : (
                <HistoryRow
                  key={e.item.id}
                  v={e.item}
                  base={base}
                  canPublish={canPublish}
                  canKeep={canKeep}
                  keep={retention.keep}
                  publishApproval={header.publishApproval}
                  busy={busy}
                />
              )
            )}
          </VersionTable>
        </>
      )}

      {retention.stored > 0 && (paging.before !== null || paging.nextBefore !== null) ? (
        <p style={styles.pager} data-testid="version-paging">
          {shown > 0 && retention.shownTo !== null && retention.shownFrom !== null ? (
            <span style={styles.muted} data-testid="version-page-range">
              Showing v{retention.shownTo}–v{retention.shownFrom} of {plural(retention.stored, 'version')}.
            </span>
          ) : null}
          {paging.before !== null && shown > 0 ? (
            <Link to={base} data-testid="versions-newest">
              Newest versions
            </Link>
          ) : null}
          {paging.nextBefore !== null ? (
            <Link to={`${base}?before=${paging.nextBefore}`} data-testid="versions-older">
              Show older versions
            </Link>
          ) : null}
        </p>
      ) : null}

      {canClean && retention.stored > 0 ? (
        <CleanupSection base={base} newest={retention.newest} cleanup={cleanup} cleanupError={cleanupError} busy={busy} />
      ) : null}
    </>
  );
}

function HistoryRow({
  v,
  base,
  canPublish,
  canKeep,
  keep,
  publishApproval,
  busy,
}: {
  v: Version;
  base: string;
  canPublish: boolean;
  canKeep: boolean;
  keep: number;
  publishApproval: Data['header']['publishApproval'];
  busy: boolean;
}) {
  return (
    <tr data-testid="version-row" data-version={v.number}>
      <CommonCells v={v} prefix="version" />
      <td style={s.td} data-cell="actions">
        <span style={{ ...s.inline, flexWrap: 'nowrap', overflowWrap: 'normal' }}>
          {canPublish && v.publishable && publishApproval ? (
            <button
              type="button"
              style={s.button}
              disabled
              title={publishApproval.notice}
              data-testid="publish-button"
              data-version={v.number}
              data-blocked={publishApproval.kind}
            >
              Publish
            </button>
          ) : canPublish && v.publishable ? (
            <Form method="post">
              <input type="hidden" name="intent" value="publish" />
              <input type="hidden" name="versionId" value={v.id} />
              <button type="submit" style={s.button} disabled={busy} data-testid="publish-button" data-version={v.number}>
                Publish
              </button>
            </Form>
          ) : null}
          {canPublish && v.restorable ? (
            <Form method="post">
              <input type="hidden" name="intent" value="restore" />
              <input type="hidden" name="version" value={v.number} />
              <button
                type="submit"
                style={s.secondaryButton}
                disabled={busy}
                title="Copy these files into a new preview version. The published version stays unchanged."
                data-testid="restore-button"
                data-version={v.number}
              >
                Restore
              </button>
            </Form>
          ) : null}
          {canKeep ? <KeepButton v={v} keep={keep} busy={busy} /> : null}
          {v.openUrl ? (
            <a href={v.openUrl} target="_blank" rel="noopener noreferrer" data-testid="version-open-link" data-version={v.number}>
              Open
            </a>
          ) : null}
          <Link to={`${base}/files?version=${v.number}`} data-testid="version-files-link" data-version={v.number}>
            Files
          </Link>
        </span>
      </td>
    </tr>
  );
}

function CleanupSection({
  base,
  newest,
  cleanup,
  cleanupError,
  busy,
}: {
  base: string;
  newest: number | null;
  cleanup: Data['cleanup'];
  cleanupError: string | null;
  busy: boolean;
}) {
  return (
    <section aria-labelledby="cleanup-title" data-testid="cleanup-section">
      <h3 id="cleanup-title" style={styles.h3}>
        Clean up history
      </h3>
      <p style={styles.note}>
        Delete old versions for good to free the workspace&apos;s source storage. The live version, the preview, kept versions,
        versions kept for a rollback, the newest version and the last hour&apos;s versions always stay. You see what goes before
        anything is deleted.
      </p>
      <Form method="get" action={base} style={s.inline}>
        <label style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
          Delete versions up to v
          <input
            type="number"
            name="cleanup"
            min={1}
            max={newest ?? undefined}
            required
            defaultValue={cleanup?.upTo ?? ''}
            style={{ ...s.input, minWidth: 0, width: '7rem' }}
            data-testid="cleanup-up-to"
          />
        </label>
        <label style={{ display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }}>
          <input type="checkbox" name="failedOnly" value="1" defaultChecked={cleanup?.failedOnly ?? false} data-testid="cleanup-failed-only" />
          only failed builds
        </label>
        <button type="submit" style={s.secondaryButton} data-testid="cleanup-review">
          Review clean-up…
        </button>
      </Form>
      {cleanupError ? (
        <p style={s.error} role="alert" data-testid="cleanup-error">
          {cleanupError}
        </p>
      ) : null}
      {cleanup ? (
        <section
          style={styles.confirm}
          tabIndex={-1}
          aria-labelledby="cleanup-confirm-title"
          data-testid="cleanup-confirm"
          data-count={cleanup.count}
          data-up-to={cleanup.upTo}
          data-plan-id={cleanup.planId}
        >
          <h4 id="cleanup-confirm-title" style={styles.confirmH}>
            {cleanup.count > 0
              ? `Delete ${plural(cleanup.count, cleanup.failedOnly ? 'failed build' : 'version')} for good?`
              : `Nothing up to v${cleanup.upTo} can be deleted`}
          </h4>
          <p style={{ margin: 0, fontSize: '0.9rem' }} data-testid="cleanup-summary">
            {cleanup.count > 0
              ? `${plural(cleanup.count, 'version')} will be deleted for good (${rangeLabel(cleanup.deleted)})`
              : 'No version will be deleted'}
            {cleanup.stayCount > 0
              ? `; ${cleanup.stayCount} stay because they are ${cleanup.stays.map((x) => x.label).join(' / ')}.`
              : '.'}
          </p>
          {cleanup.stays.length > 0 ? (
            <ul style={styles.stays}>
              {cleanup.stays.map((x) => (
                <li key={x.reason} data-testid="cleanup-stays" data-reason={x.reason}>
                  {x.label}: {rangeLabel(x.ranges)}
                </li>
              ))}
            </ul>
          ) : null}
          {cleanup.count > 0 ? (
            <p style={{ ...styles.note, marginTop: '0.4rem' }}>
              A deleted version&apos;s address, files and ZIP are gone and cannot be restored; its number is never reused. If this
              list changes before you confirm, nothing is deleted and you review the new one.
            </p>
          ) : null}
          <div style={{ ...s.inline, marginTop: '0.4rem' }}>
            {cleanup.count > 0 ? (
              <Form method="post" action={base}>
                <input type="hidden" name="intent" value="delete-versions" />
                <input type="hidden" name="upTo" value={cleanup.upTo} />
                {cleanup.failedOnly ? <input type="hidden" name="failedOnly" value="1" /> : null}
                <input type="hidden" name="planId" value={cleanup.planId} />
                <input type="hidden" name="confirmed" value="1" />
                <button type="submit" style={s.dangerButton} disabled={busy} data-testid="cleanup-confirm-submit">
                  {busy ? 'Deleting…' : `Delete ${plural(cleanup.count, 'version')}`}
                </button>
              </Form>
            ) : null}
            <Link to={base} data-testid="cleanup-cancel">
              {cleanup.count > 0 ? 'Cancel, keep them' : 'Close'}
            </Link>
          </div>
        </section>
      ) : null}
    </section>
  );
}
