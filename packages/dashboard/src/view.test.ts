import { describe, expect, it } from 'vitest';
import {
  canDeleteRecord,
  canPublish,
  canReadActivity,
  formatTimestamp,
  shapeActivity,
  shapeApps,
  shapeVersionHistory,
  type ActivityRowInput,
  type AppListRow,
  type VersionHistoryRow,
} from './view.js';

describe('formatTimestamp (deterministic — no SSR/client hydration mismatch)', () => {
  it('renders a fixed UTC string regardless of host locale/timezone', () => {
    // Byte-identical on server and client — never toLocaleString.
    expect(formatTimestamp('2026-07-03T14:51:24.000Z')).toBe(
      '2026-07-03 14:51 UTC'
    );
  });
  it('handles null/empty/invalid as an em dash', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp(undefined)).toBe('—');
    expect(formatTimestamp('not-a-date')).toBe('—');
  });
});

describe('shapeApps', () => {
  const row = (slug: string, createdAt: Date, over: Partial<AppListRow> = {}): AppListRow => ({
    slug,
    status: 'live',
    visibility: 'public',
    publishedVersionId: 'ver_x',
    createdAt,
    latestVersion: 3,
    lastChangeAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  });

  it('maps fields', () => {
    const [item] = shapeApps([row('todo', new Date('2026-01-01T00:00:00Z'))]);
    expect(item).toEqual({
      slug: 'todo',
      name: null,
      status: 'live',
      visibility: 'public',
      published: true,
      latestVersion: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastChangeAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('flags apps with no published version and no versions yet', () => {
    const [item] = shapeApps([
      row('draft', new Date('2026-01-01T00:00:00Z'), {
        publishedVersionId: null,
        latestVersion: null,
        lastChangeAt: null,
      }),
    ]);
    expect(item).toMatchObject({ published: false, latestVersion: null, lastChangeAt: null });
  });

  it('orders newest-created first, slug as tie-break', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    const items = shapeApps([
      row('b', t),
      row('a', t),
      row('newest', new Date('2026-02-01T00:00:00Z')),
    ]);
    expect(items.map((i) => i.slug)).toEqual(['newest', 'a', 'b']);
  });
});

describe('shapeVersionHistory', () => {
  const v = (number: number, over: Partial<VersionHistoryRow> = {}): VersionHistoryRow => ({
    id: `ver_${number}`,
    number,
    actorKind: 'agent',
    reasoning: null,
    compileStatus: 'ok',
    createdAt: new Date(Date.UTC(2026, 0, number)),
    published: false,
    ...over,
  });

  it('orders newest first and marks ok, unpublished versions publishable', () => {
    const items = shapeVersionHistory([
      v(1),
      v(3, { compileStatus: 'error' }),
      v(2, { published: true }),
      v(4, { compileStatus: 'pending' }),
    ]);
    expect(items.map((i) => [i.number, i.published, i.publishable])).toEqual([
      [4, false, false],
      [3, false, false],
      [2, true, false],
      [1, false, true],
    ]);
    expect(items[3].createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('canPublish (publish/rollback authorization decision)', () => {
  it('allows editor and workspace-admin', () => {
    expect(canPublish('editor')).toBe(true);
    expect(canPublish('workspace-admin')).toBe(true);
  });
  it('denies viewers and non-members', () => {
    expect(canPublish('viewer')).toBe(false);
    expect(canPublish(null)).toBe(false);
  });
});

describe('canDeleteRecord (Data-tab delete authorization)', () => {
  it('denies a viewer and a non-member (read-only)', () => {
    expect(canDeleteRecord('viewer')).toBe(false);
    expect(canDeleteRecord(null)).toBe(false);
  });
  it('allows editor and workspace-admin', () => {
    expect(canDeleteRecord('editor')).toBe(true);
    expect(canDeleteRecord('workspace-admin')).toBe(true);
  });
});

describe('canReadActivity (PHY-85 audit read authorization — pure)', () => {
  it('allows only workspace-admin (super-admin collapses to it)', () => {
    expect(canReadActivity('workspace-admin')).toBe(true);
  });
  it('denies editor, viewer, and a non-member', () => {
    expect(canReadActivity('editor')).toBe(false);
    expect(canReadActivity('viewer')).toBe(false);
    expect(canReadActivity(null)).toBe(false);
  });
});

describe('shapeActivity (PHY-85 audit-row shaping)', () => {
  const rows: ActivityRowInput[] = [
    {
      id: 'a1',
      actorEmail: 'human@example.com',
      actorKind: 'user',
      action: 'deploy.rollback',
      subjectType: 'app',
      subject: 'my-app',
      createdAt: new Date('2026-07-04T10:00:00.000Z'),
    },
    {
      id: 'a2',
      actorEmail: 'agentuser@example.com',
      actorKind: 'agent',
      action: 'deploy.activate',
      subjectType: 'app',
      subject: 'my-app',
      createdAt: new Date('2026-07-04T12:00:00.000Z'),
    },
    {
      id: 'a3',
      actorEmail: null,
      actorKind: 'user',
      action: 'member.invite',
      subjectType: 'member',
      subject: null,
      createdAt: new Date('2026-07-04T11:00:00.000Z'),
    },
  ];

  it('sorts newest-first (created_at desc, id desc tie-break)', () => {
    const shaped = shapeActivity(rows);
    expect(shaped.map((r) => r.id)).toEqual(['a2', 'a3', 'a1']);
  });

  it('maps actor_kind to a badge and the email to the actor label', () => {
    const shaped = shapeActivity(rows);
    const agent = shaped.find((r) => r.id === 'a2')!;
    expect(agent.actorBadge).toBe('agent');
    expect(agent.actorLabel).toBe('agentuser@example.com');
  });

  it('labels an actor-less row as system', () => {
    const shaped = shapeActivity(rows);
    const systemRow = shaped.find((r) => r.id === 'a3')!;
    expect(systemRow.actorLabel).toBe('system');
    expect(systemRow.actorBadge).toBe('user');
  });

  it('labels an end-user row (M1-01 module request, no drobek actor) as an app end user', () => {
    const [row] = shapeActivity([
      {
        id: 'e1',
        actorEmail: null,
        actorKind: 'end_user',
        action: 'data.export',
        subjectType: 'app',
        subject: 'my-app',
        createdAt: new Date('2026-09-23T10:00:00.000Z'),
      },
    ]);
    expect(row.actorBadge).toBe('end_user');
    expect(row.actorLabel).toBe('app end user');
  });

  it('renders a deterministic UTC time and carries the subject', () => {
    const shaped = shapeActivity(rows);
    const rollback = shaped.find((r) => r.id === 'a1')!;
    expect(rollback.time).toBe('2026-07-04 10:00 UTC');
    expect(rollback.subjectType).toBe('app');
    expect(rollback.subject).toBe('my-app');
  });

  it('is a pure function — does not mutate its input order', () => {
    const input = [...rows];
    shapeActivity(input);
    expect(input.map((r) => r.id)).toEqual(['a1', 'a2', 'a3']);
  });
});
