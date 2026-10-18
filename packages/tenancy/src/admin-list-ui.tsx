/**
 * The controls the super-admin lists share, in the dashboard's plain look:
 * the search + sort bar (a GET form: works without JavaScript and the URL
 * keeps the state), the quick-filter chips (links), the count line and the
 * pager. The loader passes `params` — the list's current URL state — so
 * every link and hidden input keeps the other filters.
 */
import { Form, Link } from 'react-router';
import { adminListHref, pageWindow } from './admin-list.js';
import { controls, mergeStyles } from './layout.js';

const chip = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0.1rem 0.6rem',
  fontSize: '0.8rem',
  borderRadius: '999px',
  border: '1px solid #d4d4d8',
  color: '#3f3f46',
  background: '#fafafa',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
} as const;

const styles = {
  bar: mergeStyles(controls.row, { margin: '1rem 0 0.5rem' }),
  chips: { display: 'flex', flexDirection: 'column', gap: '0.35rem', margin: '0.5rem 0' },
  chipRow: { display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' },
  chipLabel: mergeStyles(controls.label, { minWidth: '5.5rem' }),
  chip,
  chipActive: { ...chip, color: '#ffffff', background: '#1a1a1a', border: '1px solid #1a1a1a' },
  count: { color: '#71717a', fontSize: '0.88rem', margin: '0.5rem 0' },
  pager: { display: 'flex', alignItems: 'center', gap: '0.9rem', flexWrap: 'wrap', fontSize: '0.88rem', color: '#52525b', margin: '0.75rem 0' },
  pagerLink: { color: '#1a1a1a', fontWeight: 600 },
  pagerOff: { color: '#a1a1aa' },
} as const;

export interface AdminSortOption {
  value: string;
  label: string;
}

/**
 * Search + sort: the text field `q`, the sort select and the list's other
 * filters as hidden inputs (a new search starts on page 1). "Clear" drops
 * the search and every filter.
 */
export function AdminFilterBar({
  path,
  params,
  label,
  placeholder,
  sorts,
  testId,
}: {
  path: string;
  params: Record<string, string>;
  label: string;
  placeholder: string;
  sorts: readonly AdminSortOption[];
  testId: string;
}) {
  const kept = Object.entries(params).filter(([k, v]) => v && k !== 'q' && k !== 'sort' && k !== 'page');
  const filtered = Object.entries(params).some(([k, v]) => v && k !== 'page' && k !== 'sort');
  return (
    <Form method="get" action={path} style={styles.bar} role="search" data-testid={testId}>
      {kept.map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label style={controls.field}>
        <span style={controls.label}>{label}</span>
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ''}
          placeholder={placeholder}
          style={mergeStyles(controls.input, { width: '18rem', maxWidth: '100%' })}
          data-testid={`${testId}-q`}
        />
      </label>
      <label style={controls.field}>
        <span style={controls.label}>Sort</span>
        <select name="sort" defaultValue={params.sort || sorts[0]?.value} style={controls.select} data-testid={`${testId}-sort`}>
          {sorts.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" style={controls.secondaryButton} data-testid={`${testId}-apply`}>
        Apply
      </button>
      {filtered ? (
        <Link to={path} style={controls.link} data-testid={`${testId}-clear`}>
          Clear
        </Link>
      ) : null}
    </Form>
  );
}

export interface AdminChipGroup {
  /** The URL parameter the chips set. */
  param: string;
  label: string;
  options: readonly { value: string; label: string }[];
  /** The "everything" chip's label (it removes the parameter); none = a group without one. */
  allLabel?: string;
}

/** Quick filters: one row of link chips per group; the current one is filled. */
export function AdminChips({
  path,
  params,
  groups,
  testId,
}: {
  path: string;
  params: Record<string, string>;
  groups: readonly AdminChipGroup[];
  testId: string;
}) {
  return (
    <div style={styles.chips} data-testid={testId}>
      {groups.map((g) => {
        const current = params[g.param] ?? '';
        const options = g.allLabel ? [{ value: '', label: g.allLabel }, ...g.options] : g.options;
        return (
          <div key={g.param} style={styles.chipRow} role="group" aria-label={g.label}>
            <span style={styles.chipLabel}>{g.label}</span>
            {options.map((o) => {
              const active = o.value === current;
              return (
                <Link
                  key={o.value || 'all'}
                  to={adminListHref(path, params, { [g.param]: o.value || null })}
                  style={active ? styles.chipActive : styles.chip}
                  aria-current={active ? 'true' : undefined}
                  data-testid="admin-chip"
                  data-param={g.param}
                  data-value={o.value || 'all'}
                >
                  {o.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** "212 workspaces" or, with a search or filter, "212 workspaces · 9 match". */
export function AdminListCount({
  total,
  matching,
  filtered,
  noun,
  testId,
}: {
  total: number;
  matching: number;
  filtered: boolean;
  noun: [singular: string, plural: string];
  testId: string;
}) {
  return (
    <p style={styles.count} data-testid={testId} data-total={total} data-matching={matching}>
      {total} {total === 1 ? noun[0] : noun[1]}
      {filtered ? ` · ${matching} match${matching === 1 ? 'es' : ''}` : ''}
    </p>
  );
}

/** "Showing 51–100 of 212" with Previous / Next; nothing when everything fits on one page. */
export function AdminPager({
  path,
  params,
  page,
  pageSize,
  matching,
  testId,
}: {
  path: string;
  params: Record<string, string>;
  page: number;
  pageSize: number;
  matching: number;
  testId: string;
}) {
  const { from, to, pages } = pageWindow(page, pageSize, matching);
  if (pages <= 1) return null;
  return (
    <nav style={styles.pager} aria-label="Pages" data-testid={testId} data-page={page} data-pages={pages}>
      <span data-testid={`${testId}-range`}>
        Showing {from}–{to} of {matching}
      </span>
      {page > 1 ? (
        <Link to={adminListHref(path, params, { page: page - 1 })} style={styles.pagerLink} rel="prev" data-testid={`${testId}-prev`}>
          ← Previous
        </Link>
      ) : (
        <span style={styles.pagerOff}>← Previous</span>
      )}
      <span>
        Page {page} of {pages}
      </span>
      {page < pages ? (
        <Link to={adminListHref(path, params, { page: page + 1 })} style={styles.pagerLink} rel="next" data-testid={`${testId}-next`}>
          Next →
        </Link>
      ) : (
        <span style={styles.pagerOff}>Next →</span>
      )}
    </nav>
  );
}
