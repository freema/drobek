import { describe, expect, it } from 'vitest';
import {
  activityDetails,
  activityRefs,
  activitySummary,
  resolveActivityRefs,
  type ActivityEvent,
  type ActivityKnown,
} from './activity-view.js';

const ev = (action: string, subjectType: string | null, subject: string | null, meta: unknown = null): ActivityEvent => ({
  action,
  subjectType,
  subject,
  meta,
});

describe('activitySummary', () => {
  it('reads the events the review named as sentences', () => {
    expect(activitySummary(ev('app.publish', 'app', 'pokedex', { version: 3, previousVersion: 2, assets: 0 }))).toBe(
      'Published version 3 (replacing version 2)'
    );
    expect(activitySummary(ev('app.publish', 'app', 'pokedex', { version: 1, previousVersion: null }))).toBe('Published version 1');
    expect(activitySummary(ev('module.configure', 'app', 'pokedex', { module: 'data', keys: ['collections'] }))).toBe(
      'Changed the data module’s settings (collections)'
    );
    expect(
      activitySummary(ev('proxy.upstream.create', 'upstream', 'up_1', { name: 'github', authType: 'bearer', methods: ['GET'], pathPrefixes: ['/'] }))
    ).toBe('Registered the proxy upstream github');
    expect(activitySummary(ev('proxy.upstream.update', 'upstream', 'up_1', { name: 'anthropic', allowStreaming: true }))).toBe(
      'Turned streaming on for the proxy upstream anthropic'
    );
    expect(activitySummary(ev('proxy.upstream.update', 'upstream', 'up_1', { name: 'anthropic', allowStreaming: false }))).toBe(
      'Turned streaming off for the proxy upstream anthropic'
    );
    expect(activitySummary(ev('app.version.restore', 'app', 'x', { version: 7, restoredFrom: 4 }))).toBe(
      'Restored the files of version 4 as version 7'
    );
    expect(activitySummary(ev('app.versions.prune', 'app', 'x', { appId: 'a', versions: 12, from: 1, to: 14, keep: 200 }))).toBe(
      'The history retention deleted 12 old versions (versions 1–14)'
    );
    expect(activitySummary(ev('app.versions.prune', 'app', 'x', { versions: 1, from: 3, to: 3 }))).toBe(
      'The history retention deleted 1 old version (version 3)'
    );
    expect(activitySummary(ev('app.versions.delete', 'app', 'x', { count: 30, from: 3, to: 41, failedOnly: false }))).toBe(
      'Deleted 30 old versions (versions 3–41)'
    );
    expect(activitySummary(ev('app.versions.delete', 'app', 'x', { count: 1, from: 5, to: 5, failedOnly: true }))).toBe(
      'Deleted 1 failed build (version 5)'
    );
    expect(activitySummary(ev('app.version.keep', 'app', 'x', { version: 12 }))).toBe(
      'Kept version 12 — the history clean-up leaves it alone'
    );
    expect(activitySummary(ev('app.version.unkeep', 'app', 'x', { version: 12 }))).toBe('Stopped keeping version 12');
    expect(activityRefs(ev('app.version.keep', 'app', 'x', { version: 12 }))).toContainEqual({ kind: 'version', slug: 'x', number: 12 });
    expect(activitySummary(ev('domain.add', 'domain', 'shop.example.com', { app: 'x' }))).toBe('Added the custom domain shop.example.com');
    expect(activitySummary(ev('app.gallery_unlisted', 'app', 'x', { reason: 'takedown' }))).toContain('taken down');
    expect(activitySummary(ev('app.purge', 'app', 'x', { appId: 'app_0' }))).toBe('Deleted the app’s versions and data for good');
  });

  it('reads the member changes', () => {
    expect(activitySummary(ev('member.remove', 'member', 'u_1', { role: 'editor' }))).toBe('Removed a member (editor) from the workspace');
    expect(activitySummary(ev('member.leave', 'member', 'u_1', { role: 'viewer' }))).toBe('A member (viewer) left the workspace');
    expect(activitySummary(ev('member.invite_revoke', 'member', null, { role: 'editor' }))).toBe('Revoked a pending invite for the editor role');
    expect(activitySummary(ev('member.leave', 'member', 'u_1', { role: 'editor', reason: 'account_deleted' }))).toBe(
      'A member (editor) deleted their account and left the workspace'
    );
    expect(activitySummary(ev('member.role_change', 'member', 'u_1', { from: 'editor', to: 'viewer' }))).toBe(
      'Changed a member’s role from editor to viewer'
    );
  });

  it('reads a workspace and an account deletion', () => {
    expect(activitySummary(ev('workspace.delete', 'workspace', 'acme', { apps: 2, members: 3 }))).toBe('Deleted the workspace /acme with 2 apps');
    expect(activitySummary(ev('workspace.delete', 'workspace', 'solo', { apps: 1, members: 1, with_account: true }))).toBe(
      'Deleted the workspace /solo with 1 app together with the account'
    );
    expect(activitySummary(ev('workspace.delete', 'workspace', null, { apps: 0, members: 1, with_account: true }))).toBe(
      'Deleted the personal workspace with 0 apps together with the account'
    );
    expect(activitySummary(ev('account.delete', 'account', 'u_1', { workspaces_deleted: 1, workspaces_left: 0 }))).toBe('Deleted the account');
    expect(activityRefs(ev('workspace.delete', 'workspace', 'acme', {}))).toEqual([]);
    expect(activityRefs(ev('account.delete', 'account', 'u_1', {}))).toEqual([]);
  });

  it('reads a sign-in e-mail change, with the super-admin rights it moved', () => {
    expect(activitySummary(ev('account.email_change', 'account', 'u_1', null))).toBe('Changed the sign-in e-mail');
    expect(activitySummary(ev('account.email_change', 'account', 'u_1', { super_admin: 'gained' }))).toBe(
      'Changed the sign-in e-mail to an address with super-admin rights'
    );
    expect(activitySummary(ev('account.email_change', 'account', 'u_1', { super_admin: 'lost' }))).toBe(
      'Changed the sign-in e-mail; the new address has no super-admin rights'
    );
    expect(activityRefs(ev('account.email_change', 'account', 'u_1', {}))).toEqual([]);
  });

  it('reads a scheduled import run and a resume', () => {
    const run = (meta: unknown) => activitySummary(ev('sync.run', 'app', 'league', meta));
    expect(run({ module: 'sync', source: 'players', by: 'schedule', status: 'ok', records: 3 })).toBe('The scheduled import players wrote 3 records');
    expect(run({ module: 'sync', source: 'players', by: 'web', status: 'ok', records: 1 })).toBe('Ran the import players now — it wrote 1 record');
    expect(run({ module: 'sync', source: 'players', by: 'schedule', status: 'failed', error: 'the upstream answered HTTP 401' })).toBe(
      'The scheduled import players failed: the upstream answered HTTP 401'
    );
    expect(run({ module: 'sync', source: 'players', by: 'schedule', status: 'failed', error: 'the upstream answered HTTP 500', paused: true })).toBe(
      'The scheduled import players failed: the upstream answered HTTP 500 — the import is paused'
    );
    expect(activitySummary(ev('sync.resume', 'app', 'league', { module: 'sync', source: 'players' }))).toBe(
      'Resumed the scheduled import players after failed runs'
    );
  });

  it('tells a duplicates switch apart from listing and a description change', () => {
    const listed = (meta: unknown) => activitySummary(ev('app.gallery_listed', 'app', 'x', meta));
    expect(listed({ description: 'd', allowDuplicate: false })).toBe('Listed the app in the public gallery');
    expect(listed({ description: 'd', allowDuplicate: true })).toBe('Listed the app in the public gallery, duplicates allowed');
    expect(listed({ description: 'd', allowDuplicate: true, previousDescription: 'd', previousAllowDuplicate: false })).toBe(
      'Allowed duplicates of the app from the public gallery'
    );
    expect(listed({ description: 'd', allowDuplicate: false, previousDescription: 'd', previousAllowDuplicate: true })).toBe(
      'Stopped allowing duplicates of the app from the public gallery'
    );
    expect(listed({ description: 'new', allowDuplicate: true, previousDescription: 'old', previousAllowDuplicate: true })).toBe(
      'Changed the app’s gallery description'
    );
  });

  it('names a module secret, never a value', () => {
    const s = activitySummary(ev('module.secret_set', 'app', 'x', { module: 'email', name: 'SMTP_PASSWORD', rotated: true, value: 'hunter2' }));
    expect(s).toBe('Replaced the email module secret SMTP_PASSWORD');
    expect(s).not.toContain('hunter2');
  });

  it('keeps unknown and module-defined actions readable without inventing meaning', () => {
    expect(activitySummary(ev('hello.greet', 'app', 'x', { module: 'hello' }))).toBe('Recorded hello.greet');
    expect(activitySummary(ev('something.new', null, null))).toBe('Recorded something.new');
    expect(activitySummary(ev('constructor', null, null))).toBe('Recorded constructor');
    // Missing meta (historic rows) still reads.
    expect(activitySummary(ev('app.publish', 'app', 'x', null))).toBe('Published a version');
  });
});

describe('activityRefs + resolveActivityRefs', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  const known: ActivityKnown = {
    workspaceSlug: 'smoke',
    apps: new Map([
      ['pokedex', { id: 'app_1', name: 'Pokédex', createdAt: new Date('2026-09-01T00:00:00Z') }],
      // A NEW app that took a deleted app's slug after the event.
      ['reused', { id: 'app_9', name: null, createdAt: new Date('2026-09-25T00:00:00Z') }],
    ]),
    versions: new Set(['app_1:3']),
    modules: new Set(['data']),
    upstreams: new Set(['up_live']),
    members: new Map([['u_1', 'ann@example.com']]),
    domains: new Set(['app_1:shop.example.com']),
  };
  const links = (e: ActivityEvent, viewerIsActor = false) =>
    resolveActivityRefs(activityRefs(e), { createdAt: now, viewerIsActor }, known);

  it('links the app, the version and the module that still exist', () => {
    expect(links(ev('app.publish', 'app', 'pokedex', { version: 3 }))).toEqual([
      { label: 'Pokédex (pokedex)', href: '/workspaces/smoke/apps/pokedex', note: null },
      { label: 'version 3', href: '/workspaces/smoke/apps/pokedex/files?version=3', note: null },
    ]);
    expect(links(ev('module.configure', 'app', 'pokedex', { module: 'data', keys: [] }))[1]).toEqual({
      label: 'data module',
      href: '/workspaces/smoke/apps/pokedex/modules/data',
      note: null,
    });
  });

  it('shows a deleted object as plain text with a note, never a dead link', () => {
    expect(links(ev('app.publish', 'app', 'gone-app', { version: 1 }))).toEqual([{ label: 'gone-app', href: null, note: 'app deleted' }]);
    expect(links(ev('app.publish', 'app', 'pokedex', { version: 2 }))[1]).toEqual({ label: 'version 2', href: null, note: 'no longer exists' });
    expect(links(ev('proxy.upstream.delete', 'upstream', 'up_old', { name: 'legacy' }))).toEqual([
      { label: 'upstream legacy', href: null, note: 'deleted' },
    ]);
    expect(links(ev('proxy.upstream.create', 'upstream', 'up_live', { name: 'github' }))).toEqual([
      { label: 'upstream github', href: '/workspaces/smoke/upstreams#upstream-up_live', note: null },
    ]);
    expect(links(ev('module.configure', 'app', 'pokedex', { module: 'retired' }))[1]).toEqual({
      label: 'retired module',
      href: null,
      note: 'not on this server',
    });
    expect(links(ev('domain.remove', 'domain', 'old.example.com', { app: 'pokedex', app_id: 'app_1' }))[1]).toEqual({
      label: 'old.example.com',
      href: null,
      note: 'removed',
    });
    expect(links(ev('domain.add', 'domain', 'shop.example.com', { app: 'pokedex', app_id: 'app_1' }))[1].href).toBe(
      '/workspaces/smoke/apps/pokedex/domains'
    );
  });

  it('does not link an event of a deleted app to a newer app that reused its slug', () => {
    expect(links(ev('app.create', 'app', 'reused'))).toEqual([{ label: 'reused', href: null, note: 'app deleted' }]);
    expect(links(ev('domain.add', 'domain', 'a.example.com', { app: 'pokedex', app_id: 'app_other' }))[0].href).toBeNull();
    expect(links(ev('app.slug_release', 'app', 'pokedex', { appId: 'app_0' }))).toEqual([]);
    expect(links(ev('app.purge', 'app', 'pokedex', { appId: 'app_0' }))).toEqual([]);
  });

  it('links members and account pages only where the viewer may open them', () => {
    expect(links(ev('member.role_change', 'member', 'u_1'))).toEqual([{ label: 'ann@example.com', href: '/workspaces/smoke', note: null }]);
    expect(links(ev('member.role_change', 'member', 'u_left'))).toEqual([{ label: 'a former member', href: null, note: null }]);
    expect(links(ev('api_key.create', 'api_key', 'k_1', { name: 'CI' }))[0].href).toBeNull();
    expect(links(ev('api_key.create', 'api_key', 'k_1', { name: 'CI' }), true)[0]).toEqual({ label: 'API key CI', href: '/me/api-keys', note: null });
  });
});

describe('activityDetails', () => {
  it('redacts values under credential-like keys, keeps flags and names', () => {
    const out = activityDetails({
      module: 'email',
      name: 'SMTP_PASSWORD',
      rotated: true,
      passwordChanged: true,
      token: 'abc123',
      nested: { apiKey: 'sk-live', ok: 1, authorization: 'Bearer x' },
    })!;
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('sk-live');
    expect(out).not.toContain('Bearer x');
    expect(JSON.parse(out)).toEqual({
      module: 'email',
      name: 'SMTP_PASSWORD',
      rotated: true,
      passwordChanged: true,
      token: '[redacted]',
      nested: { apiKey: '[redacted]', ok: 1, authorization: '[redacted]' },
    });
  });

  it('is null when there is no stored context', () => {
    expect(activityDetails(null)).toBeNull();
    expect(activityDetails({})).toBeNull();
  });
});
