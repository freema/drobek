import { describe, expect, it } from 'vitest';
import {
  INTERVALS,
  collectionChoices,
  hasChoices,
  intervalChoices,
  intervalMinutes,
  selectGroups,
  upstreamChoices,
  type ChoiceList,
} from './module-choices.js';

const values = (list: ChoiceList) => list.groups.flatMap((g) => g.options.map((o) => o.value));

describe('intervals', () => {
  it('reads minutes, hours and days; anything else is no interval', () => {
    expect(intervalMinutes('15m')).toBe(15);
    expect(intervalMinutes('3h')).toBe(180);
    expect(intervalMinutes('1d')).toBe(1440);
    for (const bad of ['', '0m', '15', '1w', ' 5m', '05m']) expect(intervalMinutes(bad), bad).toBeNull();
  });

  it('without a minimum: every interval from 5 minutes to a day, labelled in words', () => {
    const list = intervalChoices(null);
    expect(values(list)).toEqual([...INTERVALS]);
    expect(list.groups[0].options.slice(0, 2)).toEqual([
      { value: '5m', label: 'every 5 minutes' },
      { value: '10m', label: 'every 10 minutes' },
    ]);
    expect(list.groups[0].options.find((o) => o.value === '1h')?.label).toBe('every hour');
    expect(list.note).toBeUndefined();
  });

  it("the workspace's minimum drops the shorter ones and is offered itself when it is not on the list", () => {
    expect(values(intervalChoices(5))).toEqual([...INTERVALS]);
    expect(values(intervalChoices(15))).toEqual(['15m', '30m', '1h', '3h', '6h', '12h', '24h']);
    expect(values(intervalChoices(7))).toEqual(['7m', '10m', '15m', '30m', '1h', '3h', '6h', '12h', '24h']);
    expect(values(intervalChoices(2000))).toEqual(['2000m']);
    expect(intervalChoices(15).note?.text).toBe('This server runs a schedule at most every 15 minutes.');
    expect(intervalChoices(1).note?.text).toBe('This server runs a schedule at most every 1 minute.');
    for (const odd of [0, -5, 2.5]) expect(values(intervalChoices(odd)), String(odd)).toEqual([...INTERVALS]);
  });
});

describe('upstreams', () => {
  const register = { href: '/workspaces/acme/upstreams', label: 'Open the Upstreams page' };
  const assign = { module: 'gateway', href: '/workspaces/acme/apps/shop/modules/gateway#upstreams', label: 'Assign an upstream' };

  it('assigned to the app first, then the rest of the workspace; a note says where to assign one', () => {
    const list = upstreamChoices({
      upstreams: [
        { name: 'weather', assigned: false },
        { name: 'scores', assigned: true },
        { name: 'news', assigned: false },
      ],
      register,
      assign,
    });
    expect(list.groups).toEqual([
      { label: 'Assigned to this app', options: [{ value: 'scores', label: 'scores' }] },
      {
        label: 'Not assigned to this app yet',
        options: [
          { value: 'news', label: 'news' },
          { value: 'weather', label: 'weather' },
        ],
      },
    ]);
    expect(list.note?.text).toContain('in the gateway module');
    expect(list.note?.link).toEqual({ href: assign.href, label: 'Assign an upstream' });
    expect(list.missing).toBe('not registered in this workspace');
  });

  it('every upstream assigned: one group, no note', () => {
    const list = upstreamChoices({ upstreams: [{ name: 'scores', assigned: true }], register, assign });
    expect(list.groups.map((g) => g.label)).toEqual(['Assigned to this app']);
    expect(list.note).toBeUndefined();
  });

  it('no module assigns upstreams: one plain list', () => {
    const list = upstreamChoices({ upstreams: [{ name: 'b', assigned: false }, { name: 'a', assigned: false }], register, assign: null });
    expect(list.groups).toEqual([{ options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }] }]);
    expect(list.note).toBeUndefined();
  });

  it('none registered: nothing to choose, the empty note leads to the Upstreams page', () => {
    const list = upstreamChoices({ upstreams: [], register, assign });
    expect(hasChoices(list)).toBe(false);
    expect(list.empty.text).toBe(
      'This workspace has no upstream yet. A workspace admin registers one on the Upstreams page; then assign it to this app in the gateway module.'
    );
    expect(list.empty.link).toEqual(register);
    expect(upstreamChoices({ upstreams: [], register, assign: null }).empty.text).not.toContain('assign it');
  });
});

describe('collections', () => {
  const create = { module: 'store', href: '/workspaces/acme/apps/shop/modules/store#collections', label: 'Create a collection' };

  it("the app's collections, sorted", () => {
    const list = collectionChoices({ collections: ['players', 'fixtures'], create });
    expect(values(list)).toEqual(['fixtures', 'players']);
    expect(hasChoices(list)).toBe(true);
  });

  it('none yet: the empty note leads to the module that creates them', () => {
    const list = collectionChoices({ collections: [], create });
    expect(hasChoices(list)).toBe(false);
    expect(list.empty).toEqual({
      text: 'This app has no data collection yet. Create one in the store module first.',
      link: { href: create.href, label: 'Create a collection' },
    });
    expect(collectionChoices({ collections: [], create: null }).empty).toEqual({ text: 'This app has no data collection yet.' });
  });
});

describe('selectGroups', () => {
  const list = collectionChoices({ collections: ['players'], create: null });

  it('a current value among the choices, or none, changes nothing', () => {
    expect(selectGroups(list, 'players')).toBe(list.groups);
    expect(selectGroups(list, '')).toBe(list.groups);
  });

  it('a current value that is not among them leads the list, marked', () => {
    expect(selectGroups(list, 'gone')).toEqual([{ options: [{ value: 'gone', label: 'gone — no such collection in this app' }] }, ...list.groups]);
    const empty = collectionChoices({ collections: [], create: null });
    expect(selectGroups(empty, 'gone')[0].options).toEqual([{ value: 'gone', label: 'gone — no such collection in this app' }]);
  });
});
