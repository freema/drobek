import { describe, expect, it } from 'vitest';
import { parseActivityQuery } from './routes/workspaces.$slug.activity.server.js';

describe('parseActivityQuery (Activity filters, M2-04 actor kind)', () => {
  it('reads app, action, actor and cursor', () => {
    const q = parseActivityQuery(
      new URL('http://x/workspaces/w/activity?app=my-app&action=data.export&actor=end_user&cursor=abc')
    );
    expect(q).toEqual({ app: 'my-app', action: 'data.export', actor: 'end_user', cursor: 'abc' });
  });

  it('drops an unknown actor kind instead of filtering on it', () => {
    expect(parseActivityQuery(new URL('http://x/a?actor=admin')).actor).toBeNull();
    expect(parseActivityQuery(new URL('http://x/a')).actor).toBeNull();
    expect(parseActivityQuery(new URL('http://x/a?actor=agent')).actor).toBe('agent');
  });
});
