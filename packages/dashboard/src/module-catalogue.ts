/**
 * The workspace Modules page's pure logic — client-safe, unit-tested in
 * module-catalogue.test.ts: a limit's value in human units, the search
 * over the module list, and how a module is named on every module page.
 *
 * Limits declare no unit; it is read from the env name (`…_BYTES`,
 * `…QUOTA…` → bytes, `…_MS` → milliseconds) or the meaning ("bytes of …",
 * "… in milliseconds"). Anything else is a count and is shown as is.
 */

export interface LimitDisplay {
  /** What the page shows, e.g. `10 MB`, `1 min`, `1,000`. */
  text: string;
  /** The exact value with its unit, e.g. `10,485,760 bytes` (null for a plain count). */
  exact: string | null;
}

type LimitUnit = 'bytes' | 'ms' | 'count';

function unitOf(name: string, meaning: string): LimitUnit {
  const n = name.toUpperCase();
  const m = meaning.toLowerCase();
  if (/(^|_)BYTES(_|$)/.test(n) || /(^|_)QUOTA(_|$)/.test(n) || m.startsWith('bytes ')) return 'bytes';
  if (/(^|_)MS(_|$)/.test(n) || m.includes('milliseconds')) return 'ms';
  return 'count';
}

const count = new Intl.NumberFormat('en-US');

function trimmed(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

function bytes(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${count.format(n)} bytes` : `${trimmed(Math.round(v * 10) / 10)} ${units[i]}`;
}

function duration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms >= 1000) return `${trimmed(Math.round(ms / 100) / 10)} s`;
  return `${count.format(ms)} ms`;
}

/** A limit's value as the page shows it, and its exact value with the unit. */
export function formatLimit(name: string, meaning: string, value: number): LimitDisplay {
  if (!Number.isFinite(value)) return { text: String(value), exact: null };
  switch (unitOf(name, meaning)) {
    case 'bytes': {
      const exact = `${count.format(value)} bytes`;
      return { text: bytes(value), exact };
    }
    case 'ms':
      return { text: duration(value), exact: `${count.format(value)} ms` };
    default:
      return { text: count.format(value), exact: null };
  }
}

/** A module as people read it: its `dashboard.title` with the name it is configured by, e.g. "Scheduled imports (sync)". */
export function moduleHeading(m: { name: string; title?: string | null }): string {
  return m.title ? `${m.title} (${m.name})` : m.name;
}

/** The line under a module's heading: its `dashboard.description`, else "Use when …" (the skill's, written for agents). */
export function moduleSummary(m: { useWhen: string; description?: string | null }): string {
  if (m.description) return m.description;
  return m.useWhen ? `Use when ${m.useWhen}` : '';
}

/** What the search looks at of one module. */
export interface SearchableModule {
  name: string;
  useWhen: string;
  title?: string | null;
  description?: string | null;
  slots: readonly { name: string }[];
  limits: readonly { name: string }[];
}

/**
 * The modules matching `query` (every word, case-insensitive, in the name,
 * title, description, "use when", a slot or a limit name). An empty query →
 * every module.
 */
export function filterModules<M extends SearchableModule>(modules: readonly M[], query: string | null | undefined): M[] {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return [...modules];
  return modules.filter((m) => {
    const hay = [m.name, m.title ?? '', m.description ?? '', m.useWhen, ...m.slots.map((s) => s.name), ...m.limits.map((l) => l.name)].join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
