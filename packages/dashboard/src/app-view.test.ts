import { describe, expect, it } from 'vitest';
import { APP_TABS, activeAppTab, appTabHref } from './app-tabs.js';
import {
  buildFileTree,
  compileSummary,
  defaultFile,
  filterApps,
  formatAgo,
  parseAppListFilters,
  safeRedirectTo,
  shapeLock,
} from './app-view.js';
import { highlight, languageOf } from './highlight.js';
import type { AppListItem } from './view.js';

describe('app tabs (data-driven)', () => {
  it('links every tab under the app base path; the base page is Overview', () => {
    expect(APP_TABS.map((t) => appTabHref('ws', 'todo', t))).toEqual([
      '/workspaces/ws/apps/todo',
      '/workspaces/ws/apps/todo/files',
      '/workspaces/ws/apps/todo/data',
      '/workspaces/ws/apps/todo/modules',
      '/workspaces/ws/apps/todo/settings',
    ]);
  });

  it.each([
    ['/workspaces/ws/apps/todo', 'overview'],
    ['/workspaces/ws/apps/todo/files', 'files'],
    ['/workspaces/ws/apps/todo/data/tasks', 'data'],
    ['/workspaces/ws/apps/todo/modules/forms', 'modules'],
    ['/workspaces/ws/apps/todo/settings', 'settings'],
    ['/workspaces/ws/apps/todo/unknown', 'overview'],
  ])('%s → %s', (path, tab) => {
    expect(activeAppTab(path, 'ws', 'todo')).toBe(tab);
  });
});

describe('shapeLock', () => {
  const now = Date.parse('2026-09-23T10:00:30Z');
  const lease = {
    holder_user_id: 'u1',
    expires_at: '2026-09-23T10:03:00Z',
    renewed_at: '2026-09-23T10:00:00Z',
  };

  it('null for a free app', () => {
    expect(shapeLock(null, new Map(), 'u1', now)).toBeNull();
  });

  it('names the holder, says whether it is the viewer, and counts seconds', () => {
    expect(shapeLock(lease, new Map([['u1', 'a@example.test']]), 'u2', now)).toEqual({
      holder: 'a@example.test',
      holderIsYou: false,
      secondsAgo: 30,
      expiresInSec: 150,
    });
    expect(shapeLock(lease, new Map(), 'u1', now)).toMatchObject({ holder: 'a former member', holderIsYou: true });
  });

  it('an older lease without renewed_at has no "ago"', () => {
    const { renewed_at: _drop, ...old } = lease;
    expect(shapeLock(old, new Map(), 'u1', now)?.secondsAgo).toBeNull();
  });

  it.each([
    [2, 'just now'],
    [42, '42 s ago'],
    [185, '3 min ago'],
    [7300, '2 h ago'],
    [200000, '2 d ago'],
  ])('formatAgo(%i) = %s', (sec, text) => {
    expect(formatAgo(sec)).toBe(text);
  });
});

describe('compileSummary', () => {
  it('counts and formats the first compiler message', () => {
    expect(compileSummary(null)).toEqual({ count: 0, first: null });
    expect(
      compileSummary([
        { code: 'build_error', file: 'src/main.tsx', line: 3, column: 7, text: 'Expected ";"\nmore' },
        { text: 'second' },
      ])
    ).toEqual({ count: 2, first: 'src/main.tsx:3:7 Expected ";"' });
    // Legacy seeds use `message`.
    expect(compileSummary([{ message: 'Unexpected token' }])).toEqual({ count: 1, first: 'Unexpected token' });
  });
});

describe('buildFileTree / defaultFile', () => {
  const files = [
    { path: 'src/main.tsx', size: 10, kind: 'source' as const },
    { path: 'index.html', size: 5, kind: 'source' as const },
    { path: 'src/components/App.tsx', size: 7, kind: 'source' as const },
    { path: 'drobek.json', size: 2, kind: 'source' as const },
    { path: 'main.js', size: 99, kind: 'built' as const },
  ];

  it('nests folders, folders first, names sorted, one kind at a time', () => {
    expect(buildFileTree(files, 'source')).toEqual([
      {
        name: 'src',
        path: 'src',
        children: [
          { name: 'components', path: 'src/components', children: [{ name: 'App.tsx', path: 'src/components/App.tsx', size: 7 }] },
          { name: 'main.tsx', path: 'src/main.tsx', size: 10 },
        ],
      },
      { name: 'drobek.json', path: 'drobek.json', size: 2 },
      { name: 'index.html', path: 'index.html', size: 5 },
    ]);
    expect(buildFileTree(files, 'built')).toEqual([{ name: 'main.js', path: 'main.js', size: 99 }]);
  });

  it('opens index.html first, else the first source file, else anything', () => {
    expect(defaultFile(files)).toEqual({ path: 'index.html', kind: 'source' });
    expect(defaultFile(files.filter((f) => f.path !== 'index.html'))).toEqual({ path: 'src/main.tsx', kind: 'source' });
    expect(defaultFile([{ path: 'main.js', size: 1, kind: 'built' }])).toEqual({ path: 'main.js', kind: 'built' });
    expect(defaultFile([])).toBeNull();
  });
});

describe('apps list filters', () => {
  const item = (slug: string, o: Partial<AppListItem> = {}): AppListItem => ({
    slug,
    name: null,
    status: 'live',
    visibility: 'public',
    published: false,
    latestVersion: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastChangeAt: null,
    ...o,
  });
  const apps = [
    item('alpha', { name: 'Zeta Tracker', published: true, createdAt: '2026-09-03T00:00:00.000Z' }),
    item('beta', { lastChangeAt: '2026-09-20T00:00:00.000Z' }),
    item('gamma', { published: true, createdAt: '2026-09-02T00:00:00.000Z', lastChangeAt: '2026-09-10T00:00:00.000Z' }),
  ];

  it('parses the query string with safe defaults', () => {
    expect(parseAppListFilters(new URLSearchParams('q=%20Tra%20&status=published&sort=name'))).toEqual({
      q: 'Tra',
      status: 'published',
      sort: 'name',
    });
    expect(parseAppListFilters(new URLSearchParams('status=deleted&sort=evil'))).toEqual({
      q: '',
      status: 'all',
      sort: 'updated',
    });
  });

  it('searches name and slug case-insensitively and filters by published state', () => {
    const f = (q: string, status: 'all' | 'published' | 'unpublished' = 'all') =>
      filterApps(apps, { q, status, sort: 'name' }).map((a) => a.slug);
    expect(f('tracker')).toEqual(['alpha']);
    expect(f('BET')).toEqual(['beta']);
    expect(f('', 'published')).toEqual(['gamma', 'alpha']);
    expect(f('', 'unpublished')).toEqual(['beta']);
  });

  it('sorts by last change, creation or name', () => {
    const sort = (s: 'updated' | 'created' | 'name') =>
      filterApps(apps, { q: '', status: 'all', sort: s }).map((a) => a.slug);
    expect(sort('updated')).toEqual(['beta', 'gamma', 'alpha']);
    expect(sort('created')).toEqual(['alpha', 'gamma', 'beta']);
    expect(sort('name')).toEqual(['beta', 'gamma', 'alpha']);
  });
});

describe('safeRedirectTo', () => {
  const base = '/workspaces/ws/apps/todo';
  it.each([
    ['/workspaces/ws/apps/todo/files?version=2', '/workspaces/ws/apps/todo/files?version=2'],
    ['/workspaces/ws/apps/todo', base],
    ['/workspaces/ws/apps/todo-other/settings', base],
    ['/workspaces/ws/apps/todo/../other', base],
    ['//evil.example/workspaces/ws/apps/todo', base],
    ['https://evil.example/', base],
    ['/\\evil', base],
    [null, base],
  ])('%s → %s', (raw, out) => {
    expect(safeRedirectTo(raw, base)).toBe(out);
  });
});

describe('highlight', () => {
  const samples: [string, ReturnType<typeof languageOf>][] = [
    ['import React from "react";\n// hi\nconst n = 42; /* c */ let s = `t${1}`;', 'js'],
    ['.a { color: #fff; margin: 1.5rem } @media (x) {} /* c */', 'css'],
    ['<!doctype html><!-- c --><div class="x" id=\'y\'>hi</div>', 'html'],
    ['{"a": [1, 2.5e3, true, null], "b": "\\"q\\""}', 'json'],
    ['plain text', 'plain'],
  ];

  it.each(samples)('is lossless: %s', (code, lang) => {
    expect(highlight(code, lang).map((t) => t.text).join('')).toBe(code);
  });

  it('classifies keywords, strings, comments, numbers and tags', () => {
    const js = highlight('const x = "a"; // c\nreturn 7;', 'js');
    expect(js.filter((t) => t.kind).map((t) => [t.kind, t.text])).toEqual([
      ['keyword', 'const'],
      ['string', '"a"'],
      ['comment', '// c'],
      ['keyword', 'return'],
      ['number', '7'],
    ]);
    const html = highlight('<a href="/x">y</a>', 'html');
    expect(html.filter((t) => t.kind).map((t) => [t.kind, t.text])).toEqual([
      ['tag', '<a'],
      ['attr', 'href'],
      ['string', '"/x"'],
      ['tag', '>'],
      ['tag', '</a'],
      ['tag', '>'],
    ]);
  });

  it('maps extensions to languages', () => {
    expect(['a.tsx', 'b.CSS', 'c.html', 'd.json', 'e.md', 'Makefile'].map(languageOf)).toEqual([
      'js',
      'css',
      'html',
      'json',
      'plain',
      'plain',
    ]);
  });
});
