import { describe, expect, it } from 'vitest';
import {
  adminListHref,
  adminListPageSize,
  lastPage,
  pageWindow,
  parseAdminList,
  pickParam,
  relativeTime,
  whenView,
} from './admin-list.js';

const SORTS = ['newest', 'oldest', 'name'] as const;

describe('admin list URL state', () => {
  it('reads q, sort and page; anything else falls back', () => {
    expect(parseAdminList(new URLSearchParams('q=%20acme%20&sort=name&page=3'), SORTS)).toEqual({ q: 'acme', sort: 'name', page: 3 });
    expect(parseAdminList(new URLSearchParams('sort=drop&page=0'), SORTS)).toEqual({ q: '', sort: 'newest', page: 1 });
    expect(parseAdminList(new URLSearchParams('page=-2'), SORTS).page).toBe(1);
    expect(parseAdminList(new URLSearchParams('page=1e3'), SORTS).page).toBe(1);
    expect(parseAdminList(new URLSearchParams(`q=${'x'.repeat(300)}`), SORTS).q).toHaveLength(200);
  });

  it('picks a chip value only from its list', () => {
    const p = new URLSearchParams('kind=team&apps=lots');
    expect(pickParam(p, 'kind', ['personal', 'team'] as const)).toBe('team');
    expect(pickParam(p, 'apps', ['none', 'some'] as const)).toBeNull();
  });

  it('ADMIN_LIST_PAGE: default 50, at most 500, a bad value falls back', () => {
    expect(adminListPageSize({})).toBe(50);
    expect(adminListPageSize({ ADMIN_LIST_PAGE: '5' })).toBe(5);
    expect(adminListPageSize({ ADMIN_LIST_PAGE: '9999' })).toBe(500);
    expect(adminListPageSize({ ADMIN_LIST_PAGE: '0' })).toBe(50);
    expect(adminListPageSize({ ADMIN_LIST_PAGE: 'many' })).toBe(50);
  });

  it('builds links that keep the other filters; a filter change goes back to page 1', () => {
    const params = { q: 'acme', kind: 'team', sort: '', page: '3' };
    expect(adminListHref('/workspaces', params, { kind: 'personal' })).toBe('/workspaces?q=acme&kind=personal');
    expect(adminListHref('/workspaces', params, { kind: null })).toBe('/workspaces?q=acme');
    expect(adminListHref('/workspaces', params, { page: 4 })).toBe('/workspaces?q=acme&kind=team&page=4');
    expect(adminListHref('/workspaces', params, { page: 1 })).toBe('/workspaces?q=acme&kind=team');
    expect(adminListHref('/x', {}, {})).toBe('/x');
  });
});

describe('pages and times', () => {
  it('says which rows a page shows', () => {
    expect(pageWindow(1, 50, 212)).toEqual({ from: 1, to: 50, pages: 5 });
    expect(pageWindow(5, 50, 212)).toEqual({ from: 201, to: 212, pages: 5 });
    expect(pageWindow(1, 50, 0)).toEqual({ from: 0, to: 0, pages: 1 });
    expect(lastPage(50, 100)).toBe(2);
    expect(lastPage(50, 101)).toBe(3);
    expect(lastPage(50, 0)).toBe(1);
  });

  it('relative times, with the absolute one for the title', () => {
    const now = new Date('2026-10-18T12:00:00Z');
    const ago = (ms: number) => relativeTime(new Date(now.getTime() - ms), now);
    expect(ago(30_000)).toBe('just now');
    expect(ago(5 * 60_000)).toBe('5 min ago');
    expect(ago(3 * 3_600_000)).toBe('3 h ago');
    expect(ago(86_400_000)).toBe('1 day ago');
    expect(ago(12 * 86_400_000)).toBe('12 days ago');
    expect(ago(120 * 86_400_000)).toBe('4 months ago');
    expect(ago(800 * 86_400_000)).toBe('2 years ago');
    expect(whenView(new Date('2026-10-17T09:05:00Z'), now)).toEqual({ ago: '1 day ago', at: '2026-10-17 09:05 UTC' });
    expect(whenView(null, now)).toBeNull();
  });
});
