import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_CSV_HEADER,
  activityCsvHeaderLine,
  activityCsvRowLine,
  type ActivityCsvRow,
} from './activity-csv.server.js';

describe('activity CSV serialization (PHY-85; reuses PHY-121 csvLine)', () => {
  it('emits the fixed governance header', () => {
    expect(activityCsvHeaderLine()).toBe(
      'time,action,actor_kind,actor,subject_type,subject,summary'
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
      summary: 'Invited someone as editor',
    };
    expect(activityCsvRowLine(row)).toBe(
      '2026-07-04T12:00:00.000Z,member.invite,user,admin@example.com,member,,Invited someone as editor'
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
      summary: 'Wrote version 2 (3 files)',
    };
    // comma-bearing actor gets quoted; embedded quote is doubled.
    expect(activityCsvRowLine(row)).toBe(
      '2026-07-04T12:00:00.000Z,deploy.activate,agent,"a,b@example.com",app,"weird""slug",Wrote version 2 (3 files)'
    );
  });

});
