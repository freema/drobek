/**
 * The choices of the config form's selects — the string fields a module
 * annotates `x-drobek-choices` (client-safe, unit-tested in
 * module-choices.test.ts). The loader gathers the facts
 * (module-choices.server.ts) and builds one list per source here; the form
 * keeps a current value that is not among the choices, marked
 * (`selectGroups`), and with no choice at all shows the list's `empty` note
 * instead of a select. The lists only help pick a value: the module's
 * configSchema on the server still decides what is valid.
 */

export interface ChoiceLink {
  href: string;
  label: string;
}

interface ChoiceOption {
  value: string;
  label: string;
}

export interface ChoiceGroup {
  /** The option group's label; without one the options are not grouped. */
  label?: string;
  options: ChoiceOption[];
}

export interface ChoiceList {
  groups: ChoiceGroup[];
  /** How a current value that is not among the choices reads next to it, e.g. "not registered in this workspace". */
  missing: string;
  /** Shown under the select. */
  note?: { text: string; link?: ChoiceLink };
  /** Shown instead of the select when there is nothing to choose: what to set up first, and where. */
  empty: { text: string; link?: ChoiceLink };
  /** The choices could not be loaded: the field is a text input with this note. */
  failed?: string;
}

/** Does the list offer anything to choose? */
export function hasChoices(list: ChoiceList): boolean {
  return list.groups.some((g) => g.options.length > 0);
}

/** The groups a select shows for `current`: the list's, led by the current value when it is not among them (marked). */
export function selectGroups(list: ChoiceList, current: string): ChoiceGroup[] {
  if (current === '' || list.groups.some((g) => g.options.some((o) => o.value === current))) return list.groups;
  return [{ options: [{ value: current, label: `${current} — ${list.missing}` }] }, ...list.groups];
}

// ── intervals ────────────────────────────────────────────────────────────────

/** The intervals a schedule select offers (before the minimum filters them). */
export const INTERVALS = ['5m', '10m', '15m', '30m', '1h', '3h', '6h', '12h', '24h'] as const;

const UNIT_MINUTES = { m: 1, h: 60, d: 1440 } as const;
const UNIT_WORD = { m: 'minute', h: 'hour', d: 'day' } as const;

/** `'15m'` → 15, `'3h'` → 180, `'1d'` → 1440; null for anything else. */
export function intervalMinutes(value: string): number | null {
  const m = /^([1-9]\d{0,4})([mhd])$/.exec(value);
  return m ? Number(m[1]) * UNIT_MINUTES[m[2] as keyof typeof UNIT_MINUTES] : null;
}

function intervalLabel(value: string): string {
  const m = /^(\d+)([mhd])$/.exec(value);
  if (!m) return value;
  const n = Number(m[1]);
  const word = UNIT_WORD[m[2] as keyof typeof UNIT_WORD];
  return n === 1 ? `every ${word}` : `every ${n} ${word}s`;
}

/**
 * The schedule intervals no shorter than `minMinutes` (the workspace's value
 * of the limit the field names; null without one). A minimum that is not
 * one of INTERVALS is offered itself, first.
 */
export function intervalChoices(minMinutes: number | null): ChoiceList {
  const min = minMinutes !== null && Number.isInteger(minMinutes) && minMinutes > 0 ? minMinutes : 0;
  const values: string[] = INTERVALS.filter((v) => (intervalMinutes(v) ?? 0) >= min);
  if (min > 0 && !values.some((v) => intervalMinutes(v) === min)) values.unshift(`${min}m`);
  return {
    groups: [{ options: values.map((value) => ({ value, label: intervalLabel(value) })) }],
    missing: 'the current value',
    ...(min > 0 ? { note: { text: `This server runs a schedule at most every ${min} minute${min === 1 ? '' : 's'}.` } } : {}),
    empty: { text: 'No interval is available.' },
  };
}

// ── upstreams ────────────────────────────────────────────────────────────────

/**
 * The upstreams registered in the app's workspace (`assigned`: the module
 * declaring the upstreams editor assigns it to this app), those assigned to
 * the app first. `assign` is the page that assigns them (null when no module
 * declares the editor: then the upstreams are not grouped).
 */
export function upstreamChoices(input: {
  upstreams: readonly { name: string; assigned: boolean }[];
  register: ChoiceLink;
  assign: (ChoiceLink & { module: string }) | null;
}): ChoiceList {
  const sorted = [...input.upstreams].sort((a, b) => a.name.localeCompare(b.name));
  const option = (u: { name: string }): ChoiceOption => ({ value: u.name, label: u.name });
  const empty = {
    text: input.assign
      ? `This workspace has no upstream yet. A workspace admin registers one on the Upstreams page; then assign it to this app in the ${input.assign.module} module.`
      : 'This workspace has no upstream yet. A workspace admin registers one on the Upstreams page.',
    link: input.register,
  };
  if (!input.assign) return { groups: [{ options: sorted.map(option) }], missing: 'not registered in this workspace', empty };
  const assigned = sorted.filter((u) => u.assigned);
  const others = sorted.filter((u) => !u.assigned);
  const groups: ChoiceGroup[] = [];
  if (assigned.length > 0) groups.push({ label: 'Assigned to this app', options: assigned.map(option) });
  if (others.length > 0) groups.push({ label: 'Not assigned to this app yet', options: others.map(option) });
  return {
    groups,
    missing: 'not registered in this workspace',
    ...(others.length > 0
      ? {
          note: {
            text: `The app can use an upstream only once it is assigned to the app (a workspace admin confirms it) — in the ${input.assign.module} module.`,
            link: { href: input.assign.href, label: input.assign.label },
          },
        }
      : {}),
    empty,
  };
}

// ── collections ──────────────────────────────────────────────────────────────

/**
 * The app's data collections (the config of the module declaring the
 * collections editor). `create` is that module's page (null when no module
 * declares the editor).
 */
export function collectionChoices(input: { collections: readonly string[]; create: (ChoiceLink & { module: string }) | null }): ChoiceList {
  const names = [...input.collections].sort((a, b) => a.localeCompare(b));
  return {
    groups: [{ options: names.map((value) => ({ value, label: value })) }],
    missing: 'no such collection in this app',
    empty: input.create
      ? { text: `This app has no data collection yet. Create one in the ${input.create.module} module first.`, link: { href: input.create.href, label: input.create.label } }
      : { text: 'This app has no data collection yet.' },
  };
}
