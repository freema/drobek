/**
 * The Activity view's reading aids, pure and client-safe:
 *
 *  - `activitySummary` — one readable sentence per audit event, built only
 *    from the secret-free fields each writer records (versions, counts,
 *    names of modules / upstreams / secrets / assets, roles, hostnames);
 *  - `activityRefs` — the objects an event is about (app, version, module,
 *    upstream, member, domain, key), which the loader resolves against what
 *    exists NOW (`resolveActivityRefs`) so a link never points at a deleted
 *    object or at a newer app that reused a deleted app's slug;
 *  - `activityDetails` — the stored row for the "Technical details"
 *    disclosure, with values under credential-like keys redacted.
 *
 * Stored audit rows are never rewritten: this only reads them.
 */

export interface ActivityEvent {
  action: string;
  subjectType: string | null;
  subject: string | null;
  meta: unknown;
}

type Meta = Record<string, unknown>;

function metaOf(meta: unknown): Meta {
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Meta) : {};
}

function str(m: Meta, key: string): string | null {
  const v = m[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

function bool(m: Meta, key: string): boolean | null {
  const v = m[key];
  return typeof v === 'boolean' ? v : null;
}

function num(m: Meta, key: string): number | null {
  const v = m[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

type Summarize = (m: Meta, e: ActivityEvent) => string;

const mod = (m: Meta) => str(m, 'module') ?? 'a';

const SUMMARIES: Record<string, Summarize> = {
  'app.create': () => 'Created the app',
  'app.version.write': (m) => {
    const v = num(m, 'version');
    const files = num(m, 'files');
    return `Wrote ${v !== null ? `version ${v}` : 'a new version'}${files !== null ? ` (${plural(files, 'file')})` : ''}`;
  },
  'app.version.restore': (m) => {
    const v = num(m, 'version');
    const from = num(m, 'restoredFrom');
    return `Restored the files of ${from !== null ? `version ${from}` : 'an earlier version'}${v !== null ? ` as version ${v}` : ''}`;
  },
  'app.publish': (m) => {
    const v = num(m, 'version');
    const prev = num(m, 'previousVersion');
    return `Published ${v !== null ? `version ${v}` : 'a version'}${prev !== null ? ` (replacing version ${prev})` : ''}`;
  },
  'app.unpublish': (m) => {
    const prev = num(m, 'previousVersion');
    return `Unpublished the app${prev !== null ? ` (version ${prev} was live)` : ''}`;
  },
  'deploy.activate': () => 'Activated an uploaded deploy (earlier upload pipeline)',
  'deploy.rollback': () => 'Rolled back to an earlier deploy (earlier upload pipeline)',
  'app.delete': () => 'Deleted the app',
  'app.slug_release': () => 'Released the deleted app’s address for reuse',
  'app.purge': () => 'Deleted the app’s versions and data for good',
  'app.lock.release': () => 'Released the agent’s edit lock on the app',
  'app.visibility.public': () => 'Made the app public (no password)',
  'app.visibility.password': (m) =>
    m.passwordChanged === false
      ? 'Put the app behind its existing password'
      : str(m, 'previous') === 'password'
        ? 'Changed the app password'
        : 'Put the app behind a password',
  'app.frame_ancestors.change': (m) => {
    const v = str(m, 'value');
    return v ? `Allowed embedding the app on ${v}` : 'Turned off embedding the app on other sites';
  },
  'member.invite': (m) => `Invited someone${str(m, 'role') ? ` as ${str(m, 'role')}` : ''}`,
  'member.accept': (m) => `A member joined${str(m, 'role') ? ` as ${str(m, 'role')}` : ''}`,
  'member.role_change': (m) => {
    const from = str(m, 'from');
    const to = str(m, 'to') ?? str(m, 'role');
    return `Changed a member’s role${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}`;
  },
  'module.configure': (m) => {
    const keys = Array.isArray(m.keys) ? m.keys.filter((k): k is string => typeof k === 'string') : [];
    return `Changed the ${mod(m)} module’s settings${keys.length ? ` (${keys.join(', ')})` : ''}`;
  },
  'module.pending': (m) => `Proposed a ${mod(m)} module change that waits for confirmation`,
  'module.confirm': (m) => `Confirmed the pending ${mod(m)} module change`,
  'module.reject': (m) => `Rejected the pending ${mod(m)} module change`,
  'module.secret_set': (m) => `${m.rotated === true ? 'Replaced' : 'Set'} the ${mod(m)} module secret ${str(m, 'name') ?? ''}`.trim(),
  'module.secret_remove': (m) => `Removed the ${mod(m)} module secret ${str(m, 'name') ?? ''}`.trim(),
  'module.workspace_enable': (m, e) => `Enabled the ${str(m, 'module') ?? e.subject ?? 'a'} module for this workspace`,
  'module.workspace_disable': (m, e) => `Disabled the ${str(m, 'module') ?? e.subject ?? 'a'} module for this workspace`,
  'auth.sign_in': (m) => `An end user signed in to the app${str(m, 'provider') ? ` (${str(m, 'provider')})` : ''}`,
  'auth.sign_in_denied': (m) => `An end user’s sign-in was refused${str(m, 'reason') ? ` (${str(m, 'reason')})` : ''}`,
  'auth.identity_relinked': () => 'An end user’s sign-in identity was linked to their existing account',
  'files.upload': (m) => `An end user uploaded a file${num(m, 'size') !== null ? ` (${plural(num(m, 'size')!, 'byte')})` : ''}`,
  'end_users.sessions_revoke': () => 'Signed every end user of the app out',
  'end_users.role': (m) => `Changed an end user’s role${str(m, 'role') ? ` to ${str(m, 'role')}` : ''}`,
  'end_users.disable': () => 'Blocked an end user of the app',
  'end_users.enable': () => 'Unblocked an end user of the app',
  'email.send': (m) => {
    const n = num(m, 'recipients');
    const kind = str(m, 'kind');
    return `Sent ${n !== null ? plural(n, 'e-mail') : 'e-mail'}${kind ? ` (${kind})` : ''}`;
  },
  'forms.export': (m) => {
    const rows = num(m, 'rows');
    const form = str(m, 'form');
    return `Exported ${form ? `the ${form} form’s` : 'form'} submissions as CSV${rows !== null ? ` (${plural(rows, 'row')})` : ''}`;
  },
  'forms.submission_delete': () => 'Deleted a form submission',
  'data.export': (m) => {
    const rows = num(m, 'rows');
    const c = str(m, 'collection');
    return `Exported ${c ? `the ${c} collection` : 'a collection'} as CSV${rows !== null ? ` (${plural(rows, 'row')})` : ''}`;
  },
  'data.record_update': (m) => `Edited a record${str(m, 'collection') ? ` in ${str(m, 'collection')}` : ''}`,
  'data.record_delete': (m) => `Deleted a record${str(m, 'collection') ? ` from ${str(m, 'collection')}` : ''}`,
  'data.import': (m) => {
    const rows = num(m, 'rows');
    return `Imported ${rows !== null ? plural(rows, 'row') : 'rows'}${str(m, 'collection') ? ` into ${str(m, 'collection')}` : ''}`;
  },
  'data.collection_delete': (m) => {
    const n = num(m, 'records');
    return `Deleted the collection ${str(m, 'collection') ?? ''}${n !== null ? ` (${plural(n, 'record')})` : ''}`.replace('  ', ' ');
  },
  'data.collection.purge': (m) => {
    const n = num(m, 'records');
    return `Purged the records of the removed collection ${str(m, 'collection') ?? ''}${n !== null ? ` (${plural(n, 'record')})` : ''}`.replace('  ', ' ');
  },
  'files.delete': () => 'Deleted an uploaded file',
  'sync.run': (m) => {
    const name = str(m, 'source') ? ` ${str(m, 'source')}` : '';
    const n = num(m, 'records');
    const result =
      str(m, 'status') === 'failed'
        ? `failed${str(m, 'error') ? `: ${str(m, 'error')}` : ''}`
        : `wrote ${n !== null ? plural(n, 'record') : 'its records'}`;
    const paused = m.paused === true ? ' — the import is paused' : '';
    return m.by === 'schedule' ? `The scheduled import${name} ${result}${paused}` : `Ran the import${name} now — it ${result}${paused}`;
  },
  'sync.resume': (m) => `Resumed the scheduled import ${str(m, 'source') ?? ''} after failed runs`.replace('  ', ' '),
  'asset.upload': (m) => `${m.replaced === true ? 'Replaced' : 'Uploaded'} the asset ${str(m, 'name') ?? ''}`.trim(),
  'asset.delete': (m) => `Deleted the asset ${str(m, 'name') ?? ''}`.trim(),
  'proxy.upstream.create': (m) => `Registered the proxy upstream ${str(m, 'name') ?? ''}`.trim(),
  'proxy.upstream.delete': (m) => `Deleted the proxy upstream ${str(m, 'name') ?? ''}`.trim(),
  'proxy.blocked': (m) => {
    const up = str(m, 'upstream');
    const reason = str(m, 'reason');
    return `The proxy refused a call${up ? ` to ${up}` : ''}${reason ? ` (${reason})` : ''}`;
  },
  'api_key.create': (m) => `Created the API key ${str(m, 'name') ?? ''}`.trim(),
  'api_key.revoke': (m) => `Revoked the API key ${str(m, 'name') ?? ''}`.trim(),
  'oauth_client.revoke': () => 'Revoked a connected client’s access',
  'domain.add': (_m, e) => `Added the custom domain ${e.subject ?? ''}`.trim(),
  'domain.verify': (_m, e) => `Verified the custom domain ${e.subject ?? ''}`.trim(),
  'domain.unverify': (_m, e) => `The custom domain ${e.subject ?? ''} lost its verification (its DNS records are gone)`.replace('  ', ' '),
  'domain.primary': (m) => (str(m, 'primary') ? `Made ${str(m, 'primary')} the primary domain` : 'Cleared the primary domain'),
  'domain.remove': (_m, e) => `Removed the custom domain ${e.subject ?? ''}`.trim(),
  'abuse.report': (m) => `Someone reported the app${str(m, 'reason') ? ` (${str(m, 'reason')})` : ''}`,
  'admin.takedown': (m) => `The server operator took the app down${str(m, 'reason') ? ` (${str(m, 'reason')})` : ''}`,
  'admin.restore': () => 'The server operator lifted the takedown (the app stays unpublished)',
  'app.gallery_listed': (m) => {
    const allow = bool(m, 'allowDuplicate');
    const before = bool(m, 'previousAllowDuplicate');
    if (before !== null && allow !== null && allow !== before) {
      return allow ? 'Allowed duplicates of the app from the public gallery' : 'Stopped allowing duplicates of the app from the public gallery';
    }
    if (before !== null) return 'Changed the app’s gallery description';
    return allow ? 'Listed the app in the public gallery, duplicates allowed' : 'Listed the app in the public gallery';
  },
  'app.gallery_unlisted': (m) => {
    const reason = str(m, 'reason');
    if (reason === 'unpublish') return 'The app left the public gallery because it was unpublished';
    if (reason === 'takedown') return 'The app left the public gallery because it was taken down';
    return 'Removed the app from the public gallery';
  },
  'app.gallery_hidden': () => 'The server operator hid the app from the public gallery',
  'app.gallery_unhidden': () => 'The server operator allowed the app in the public gallery again',
  'app.duplicate': (m) => {
    const from = str(m, 'from');
    const v = num(m, 'version');
    return `Created as a copy of ${from ?? 'a gallery app'}${v !== null ? ` (version ${v})` : ''}`;
  },
  'app.duplicated': () => 'Someone duplicated this gallery app',
  'workspace.publish_approval_request': () => 'Asked the server operator to approve publishing',
  'workspace.publish_approve': () => 'The server operator allowed this workspace to publish',
  'workspace.publish_revoke': () => 'The server operator took the publishing approval back',
  'workspace.publish_block': () => 'The server operator turned publishing off for this workspace',
  'workspace.publish_unblock': () => 'The server operator turned publishing back on for this workspace',
};

/** One readable sentence for an audit event (unknown actions fall back to their name). */
export function activitySummary(e: ActivityEvent): string {
  const m = metaOf(e.meta);
  const fn = Object.hasOwn(SUMMARIES, e.action) ? SUMMARIES[e.action] : undefined;
  if (fn) return fn(m, e);
  const module = str(m, 'module');
  return module && !e.action.startsWith(`${module}.`) ? `${module} module: ${e.action}` : `Recorded ${e.action}`;
}

// ── objects an event is about ────────────────────────────────────────────────

export type ActivityRef =
  | { kind: 'app'; slug: string; appId: string | null }
  | { kind: 'version'; slug: string; number: number }
  | { kind: 'appModule'; slug: string; module: string }
  | { kind: 'domain'; slug: string; hostname: string }
  | { kind: 'workspaceModule'; module: string }
  | { kind: 'upstream'; id: string; name: string | null }
  | { kind: 'member'; userId: string }
  | { kind: 'apiKey'; name: string | null }
  | { kind: 'oauthClient' };

const VERSION_KEY: Record<string, string> = {
  'app.version.write': 'version',
  'app.version.restore': 'version',
  'app.publish': 'version',
  'app.unpublish': 'previousVersion',
};

export function activityRefs(e: ActivityEvent): ActivityRef[] {
  const m = metaOf(e.meta);
  const subject = e.subject;
  if (!subject && e.subjectType !== 'domain') return [];
  const appId = str(m, 'app_id') ?? str(m, 'appId');
  switch (e.subjectType) {
    case 'app': {
      // A released slug's app was renamed to its tombstone, a purged one is gone: nothing to link.
      if (e.action === 'app.slug_release' || e.action === 'app.purge') return [];
      const refs: ActivityRef[] = [{ kind: 'app', slug: subject!, appId }];
      const key = VERSION_KEY[e.action];
      const n = key ? num(m, key) : null;
      if (n !== null) refs.push({ kind: 'version', slug: subject!, number: n });
      const module = str(m, 'module');
      if (module) refs.push({ kind: 'appModule', slug: subject!, module });
      return refs;
    }
    case 'domain': {
      const slug = str(m, 'app');
      if (!slug) return [];
      const refs: ActivityRef[] = [{ kind: 'app', slug, appId }];
      if (subject) refs.push({ kind: 'domain', slug, hostname: subject });
      return refs;
    }
    case 'module':
      return [{ kind: 'workspaceModule', module: subject! }];
    case 'upstream':
      return [{ kind: 'upstream', id: subject!, name: str(m, 'name') }];
    case 'member':
      return [{ kind: 'member', userId: subject! }];
    case 'api_key':
      return [{ kind: 'apiKey', name: str(m, 'name') }];
    case 'oauth_client':
      return [{ kind: 'oauthClient' }];
    default:
      return [];
  }
}

/** What exists now (read by the loader) — the links are built only from this. */
export interface ActivityKnown {
  workspaceSlug: string;
  /** Live apps by slug: id + created_at (an app newer than the event is another app). */
  apps: Map<string, { id: string; name: string | null; createdAt: Date }>;
  /** `${appId}:${number}` for every version that still exists. */
  versions: Set<string>;
  /** Module names this server runs. */
  modules: Set<string>;
  /** Upstream ids of the workspace. */
  upstreams: Set<string>;
  /** Current members: user id → e-mail. */
  members: Map<string, string>;
  /** `${appId}:${hostname}` for every attached domain. */
  domains: Set<string>;
}

export interface ActivityLink {
  label: string;
  /** A dashboard path, or null when the object is gone or not the viewer's to open. */
  href: string | null;
  /** Why there is no link (e.g. "deleted"), shown next to the label. */
  note: string | null;
}

/**
 * Links for one event. `viewerIsActor`: the event is the viewer's own, so a
 * key or connection it names is on the viewer's account pages (nobody else's
 * account page is ever linked).
 */
export function resolveActivityRefs(
  refs: ActivityRef[],
  event: { createdAt: Date; viewerIsActor: boolean },
  known: ActivityKnown
): ActivityLink[] {
  const createdAt = event.createdAt;
  const ws = `/workspaces/${known.workspaceSlug}`;
  const appOf = (slug: string, appId: string | null) => {
    const a = known.apps.get(slug);
    if (!a) return null;
    if (appId ? a.id !== appId : a.createdAt.getTime() > createdAt.getTime()) return null;
    return a;
  };
  const links: ActivityLink[] = [];
  let appGone = false;
  for (const ref of refs) {
    if (ref.kind === 'app') {
      const a = appOf(ref.slug, ref.appId);
      appGone = !a;
      links.push(
        a
          ? { label: a.name ? `${a.name} (${ref.slug})` : ref.slug, href: `${ws}/apps/${ref.slug}`, note: null }
          : { label: ref.slug, href: null, note: 'app deleted' }
      );
    } else if (ref.kind === 'version') {
      const a = appOf(ref.slug, null);
      if (appGone || !a) continue;
      const exists = known.versions.has(`${a.id}:${ref.number}`);
      links.push({
        label: `version ${ref.number}`,
        href: exists ? `${ws}/apps/${ref.slug}/files?version=${ref.number}` : null,
        note: exists ? null : 'no longer exists',
      });
    } else if (ref.kind === 'appModule') {
      if (appGone) {
        links.push({ label: `${ref.module} module`, href: null, note: null });
        continue;
      }
      const onServer = known.modules.has(ref.module);
      links.push({
        label: `${ref.module} module`,
        href: onServer ? `${ws}/apps/${ref.slug}/modules/${encodeURIComponent(ref.module)}` : null,
        note: onServer ? null : 'not on this server',
      });
    } else if (ref.kind === 'domain') {
      const a = appOf(ref.slug, null);
      const attached = !appGone && a !== null && known.domains.has(`${a.id}:${ref.hostname}`);
      links.push({
        label: ref.hostname,
        href: attached ? `${ws}/apps/${ref.slug}/domains` : null,
        note: attached || appGone ? null : 'removed',
      });
    } else if (ref.kind === 'workspaceModule') {
      const onServer = known.modules.has(ref.module);
      links.push({ label: `${ref.module} module`, href: onServer ? `${ws}/modules` : null, note: onServer ? null : 'not on this server' });
    } else if (ref.kind === 'upstream') {
      const exists = known.upstreams.has(ref.id);
      links.push({
        label: `upstream ${ref.name ?? ref.id}`,
        href: exists ? `${ws}/upstreams#upstream-${ref.id}` : null,
        note: exists ? null : 'deleted',
      });
    } else if (ref.kind === 'member') {
      const email = known.members.get(ref.userId);
      links.push(email ? { label: email, href: ws, note: null } : { label: 'a former member', href: null, note: null });
    } else if (ref.kind === 'apiKey') {
      links.push({
        label: `API key ${ref.name ?? ''}`.trim(),
        href: event.viewerIsActor ? '/me/api-keys' : null,
        note: null,
      });
    } else {
      links.push({ label: 'connected client', href: event.viewerIsActor ? '/me/connections' : null, note: null });
    }
  }
  return links;
}

// ── technical details ────────────────────────────────────────────────────────

const SENSITIVE_KEY = /secret|passw|token|authorization|cookie|api[_-]?key|private[_-]?key|credential/i;

/** A copy of `meta` with every non-boolean value under a credential-like key replaced. */
function redactMeta(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (Array.isArray(value)) return value.map((v) => redactMeta(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Meta)) {
      out[k] = SENSITIVE_KEY.test(k) && typeof v !== 'boolean' && v !== null ? '[redacted]' : redactMeta(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** The stored context of an event as indented JSON (redacted), or null when there is none. */
export function activityDetails(meta: unknown): string | null {
  if (meta === null || meta === undefined) return null;
  if (typeof meta === 'object' && !Array.isArray(meta) && Object.keys(meta).length === 0) return null;
  return JSON.stringify(redactMeta(meta), null, 2);
}

// ── time range ───────────────────────────────────────────────────────────────

/** A `YYYY-MM-DD` calendar day (UTC), or null. */
export function parseDay(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

/**
 * The instants of an inclusive UTC day range: `from` 00:00 and the midnight
 * after `to`. A reversed range is put in order.
 */
export function dayRange(from: string | null, to: string | null): { from: string | null; to: string | null; start: Date | null; until: Date | null } {
  let a = from;
  let b = to;
  if (a && b && a > b) [a, b] = [b, a];
  const start = a ? new Date(`${a}T00:00:00.000Z`) : null;
  const until = b ? new Date(new Date(`${b}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000) : null;
  return { from: a, to: b, start, until };
}
