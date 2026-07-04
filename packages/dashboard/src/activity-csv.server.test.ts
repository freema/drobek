import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_CSV_HEADER,
  activityCsvHeaderLine,
  activityCsvLines,
  activityCsvRowLine,
  type ActivityCsvRow,
} from './activity-csv.server.js';

describe('activity CSV serialization (PHY-85; reuses PHY-121 csvLine)', () => {
  it('emits the fixed governance header', () => {
    expect(activityCsvHeaderLine()).toBe(
      'time,action,actor_kind,actor,subject_type,subject'
    );
    expect(ACTIVITY_CSV_HEADER).toContain('actor_kind');
  });

  it('serializes a row in column order, empty string for null subject', () => {
    const row: ActivityCsvRow = {
      createdAt: '2026-07-04T12:00:00.000Z',
      action: 'member.invite',
      actorKind: 'user',
      actor: 'admin@example.com',
      subjectType: 'member',
      subject: null,
    };
    expect(activityCsvRowLine(row)).toBe(
      '2026-07-04T12:00:00.000Z,member.invite,user,admin@example.com,member,'
    );
  });

  it('RFC-4180 escapes commas / quotes in values', () => {
    const row: ActivityCsvRow = {
      createdAt: '2026-07-04T12:00:00.000Z',
      action: 'deploy.activate',
      actorKind: 'agent',
      actor: 'a,b@example.com',
      subjectType: 'app',
      subject: 'weird"slug',
    };
    // comma-bearing actor gets quoted; embedded quote is doubled.
    expect(activityCsvRowLine(row)).toBe(
      '2026-07-04T12:00:00.000Z,deploy.activate,agent,"a,b@example.com",app,"weird""slug"'
    );
  });

  it('activityCsvLines prepends the header before the rows', () => {
    const rows: ActivityCsvRow[] = [
      {
        createdAt: '2026-07-04T12:00:00.000Z',
        action: 'app.create',
        actorKind: 'agent',
        actor: '',
        subjectType: 'app',
        subject: 'my-app',
      },
    ];
    const lines = activityCsvLines(rows);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(activityCsvHeaderLine());
    expect(lines[1]).toBe(
      '2026-07-04T12:00:00.000Z,app.create,agent,,app,my-app'
    );
  });
});
