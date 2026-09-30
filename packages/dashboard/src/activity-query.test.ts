import { describe, expect, it } from 'vitest';
import { parseActivityQuery } from './routes/workspaces.$slug.activity.server.js';

describe('parseActivityQuery (Activity filters, actor kind)', () => {
  it('reads app, action, actor and cursor', () => {
    const q = parseActivityQuery(
      new URL('http://x/workspaces/w/activity?app=my-app&action=data.export&actor=end_user&cursor=abc')
    );
    expect(q).toEqual({ app: 'my-app', action: 'data.export', actor: 'end_user', cursor: 'abc', from: null, to: null, start: null, until: null });
  });

  it('reads an inclusive UTC day range; a bad date is ignored, a reversed range put in order', () => {
    const q = parseActivityQuery(new URL('http://x/a?from=2026-09-01&to=2026-09-03'));
    expect(q).toMatchObject({ from: '2026-09-01', to: '2026-09-03' });
    expect(q.start?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(q.until?.toISOString()).toBe('2026-09-04T00:00:00.000Z');
    expect(parseActivityQuery(new URL('http://x/a?from=2026-02-30&to=yesterday'))).toMatchObject({ from: null, to: null, start: null, until: null });
    const reversed = parseActivityQuery(new URL('http://x/a?from=2026-09-10&to=2026-09-02'));
    expect(reversed).toMatchObject({ from: '2026-09-02', to: '2026-09-10' });
    expect(parseActivityQuery(new URL('http://x/a?to=2026-09-02')).until?.toISOString()).toBe('2026-09-03T00:00:00.000Z');
  });

  it('drops an unknown actor kind instead of filtering on it', () => {
    expect(parseActivityQuery(new URL('http://x/a?actor=admin')).actor).toBeNull();
    expect(parseActivityQuery(new URL('http://x/a')).actor).toBeNull();
    expect(parseActivityQuery(new URL('http://x/a?actor=agent')).actor).toBe('agent');
  });
});
