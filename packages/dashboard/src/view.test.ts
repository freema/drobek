import { describe, expect, it } from 'vitest';
import {
  canDeleteRecord,
  canReadActivity,
  canRollback,
  deployShortId,
  formatTimestamp,
  lintStatusOf,
  servePath,
  shapeActivity,
  shapeApps,
  shapeDeployHistory,
  type ActivityRowInput,
  type AppListRow,
  type DeployHistoryRow,
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

describe('servePath', () => {
  it('builds the U7 same-origin serving path', () => {
    expect(servePath('acme', 'todo')).toBe('/acme/app/todo');
  });
});

describe('shapeApps', () => {
  const row = (
    slug: string,
    createdAt: Date,
    over: Partial<AppListRow> = {}
  ): AppListRow => ({
    slug,
    status: 'live',
    visibility: 'public',
    activeDeployId: 'dep_x',
    createdAt,
    lastDeployAt: null,
    ...over,
  });

  it('maps fields and builds the live URL', () => {
    const [item] = shapeApps(
      [row('todo', new Date('2026-01-01T00:00:00Z'), { lastDeployAt: new Date('2026-01-02T00:00:00Z') })],
      'acme'
    );
    expect(item).toMatchObject({
      slug: 'todo',
      status: 'live',
      visibility: 'public',
      live: true,
      url: '/acme/app/todo',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastDeployAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('flags apps with no active deploy as not live', () => {
    const [item] = shapeApps(
      [row('draft', new Date('2026-01-01T00:00:00Z'), { activeDeployId: null })],
      'acme'
    );
    expect(item.live).toBe(false);
    expect(item.lastDeployAt).toBeNull();
  });

  it('sorts newest-created first, slug as tie-break', () => {
    const same = new Date('2026-01-01T00:00:00Z');
    const items = shapeApps(
      [
        row('old', new Date('2025-01-01T00:00:00Z')),
        row('beta', same),
        row('alpha', same),
        row('newest', new Date('2027-01-01T00:00:00Z')),
      ],
      'acme'
    );
    expect(items.map((i) => i.slug)).toEqual(['newest', 'alpha', 'beta', 'old']);
  });
});

describe('deployShortId / lintStatusOf', () => {
  it('takes the first 8 chars', () => {
    expect(deployShortId('abcdef0123456789')).toBe('abcdef01');
  });

  it('maps the lint report to a status', () => {
    expect(lintStatusOf({ ok: true })).toBe('clean');
    expect(lintStatusOf({ ok: false })).toBe('blocked');
    expect(lintStatusOf(null)).toBe('unknown');
    expect(lintStatusOf({})).toBe('unknown');
  });
});

describe('shapeDeployHistory', () => {
  const dep = (
    id: string,
    createdAt: Date,
    over: Partial<DeployHistoryRow> = {}
  ): DeployHistoryRow => ({
    id,
    state: 'ready',
    createdAt,
    activatedAt: createdAt,
    lintReport: { ok: true },
    ...over,
  });

  it('orders newest-first and flags the active deploy', () => {
    const items = shapeDeployHistory(
      [
        dep('v1aaaaaa1111', new Date('2026-01-01T00:00:00Z')),
        dep('v2bbbbbb2222', new Date('2026-01-02T00:00:00Z')),
      ],
      'v2bbbbbb2222'
    );
    expect(items.map((i) => i.id)).toEqual(['v2bbbbbb2222', 'v1aaaaaa1111']);
    expect(items[0].active).toBe(true);
    expect(items[1].active).toBe(false);
  });

  it('marks prior READY deploys (not the active one) as rollback targets', () => {
    const items = shapeDeployHistory(
      [
        dep('v1aaaaaa1111', new Date('2026-01-01T00:00:00Z')),
        dep('v2bbbbbb2222', new Date('2026-01-02T00:00:00Z')),
        dep('v3ffffff3333', new Date('2026-01-03T00:00:00Z'), {
          state: 'failed',
          activatedAt: null,
          lintReport: { ok: false },
        }),
      ],
      'v2bbbbbb2222'
    );
    const byId = new Map(items.map((i) => [i.id, i]));
    // The active ready deploy is not a rollback target...
    expect(byId.get('v2bbbbbb2222')?.rollbackTarget).toBe(false);
    // ...a prior READY one is...
    expect(byId.get('v1aaaaaa1111')?.rollbackTarget).toBe(true);
    // ...and a failed deploy never is.
    expect(byId.get('v3ffffff3333')?.rollbackTarget).toBe(false);
    expect(byId.get('v3ffffff3333')?.lintStatus).toBe('blocked');
  });

  it('shortens ids and serializes timestamps', () => {
    const [item] = shapeDeployHistory(
      [dep('deadbeefcafe0000', new Date('2026-01-01T00:00:00Z'))],
      null
    );
    expect(item.shortId).toBe('deadbeef');
    expect(item.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(item.active).toBe(false);
  });
});

describe('canRollback (rollback authorization decision)', () => {
  it('denies a viewer and a non-member', () => {
    expect(canRollback('viewer')).toBe(false);
    expect(canRollback(null)).toBe(false);
  });

  it('allows editor, workspace-admin, and super-admin (effective workspace-admin)', () => {
    expect(canRollback('editor')).toBe(true);
    expect(canRollback('workspace-admin')).toBe(true);
    // requireWorkspaceRole collapses a super-admin to effectiveRole
    // 'workspace-admin', so the same path allows them.
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
