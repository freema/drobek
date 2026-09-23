import { and, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onLocalAppChanged, type AppChangedEvent } from '@drobek/apps';
import { apps, auditLog, domains, memberships, users, workspaces } from '@drobek/db';
import {
  DomainsError,
  addDomain,
  customDomainAskAllowed,
  listDomains,
  primaryDomainOf,
  recheckDueDomains,
  removeDomain,
  resolveCustomHost,
  setPrimaryDomain,
  verifyDomain,
  type DnsResolver,
  type DomainActor,
  type DomainApp,
  type DomainLostNotice,
} from './index.js';
import { freshDb, type TestDb } from './test/db.js';

const ENV = {
  NODE_ENV: 'test',
  APPS_DOMAIN: 'drobek.app',
  PUBLIC_APP_URL: 'https://drobek.app',
} as NodeJS.ProcessEnv;

let db: TestDb;
let close: () => Promise<void>;
let wsId: string;
let actor: DomainActor;
const events: AppChangedEvent[] = [];
let offEvents: () => void;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [owner] = await db.insert(users).values({ email: 'owner@example.test' }).returning();
  const [editor] = await db.insert(users).values({ email: 'Editor@Example.test' }).returning();
  const [viewer] = await db.insert(users).values({ email: 'viewer@example.test' }).returning();
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'firma', name: 'Firma' }).returning();
  wsId = w.id;
  await db.insert(memberships).values([
    { userId: owner.id, workspaceId: wsId, role: 'workspace-admin' },
    { userId: editor.id, workspaceId: wsId, role: 'editor' },
    { userId: viewer.id, workspaceId: wsId, role: 'viewer' },
  ]);
  actor = { userId: owner.id, kind: 'user' };
  offEvents = onLocalAppChanged((e) => events.push(e));
});
afterAll(async () => {
  offEvents();
  await close();
});

let n = 0;
async function newApp(): Promise<DomainApp> {
  n += 1;
  const [a] = await db.insert(apps).values({ workspaceId: wsId, slug: `shop-${n}` }).returning();
  return { id: a.id, slug: a.slug, workspaceId: wsId };
}

/** A resolver over a mutable zone (missing = NODATA). */
function zoneResolver(zone: { txt: Record<string, string[]>; cname: Record<string, string[]>; fail?: Set<string> }): DnsResolver {
  const read = async (map: Record<string, string[]>, name: string) => {
    if (zone.fail?.has(name)) throw Object.assign(new Error('servfail'), { code: 'ESERVFAIL' });
    const v = map[name];
    if (!v) throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
    return v;
  };
  return {
    resolveTxt: async (name) => (await read(zone.txt, name)).map((v) => [v]),
    resolveCname: (name) => read(zone.cname, name),
    resolve4: () => Promise.reject(Object.assign(new Error('nodata'), { code: 'ENODATA' })),
    resolve6: () => Promise.reject(Object.assign(new Error('nodata'), { code: 'ENODATA' })),
  };
}

async function auditActions(hostname: string): Promise<string[]> {
  const rows = await db.select().from(auditLog).where(eq(auditLog.target, hostname)).orderBy(auditLog.createdAt);
  return rows.map((r) => r.action);
}

const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as DomainsError);

describe('addDomain', () => {
  it('normalises, stores unverified with a token, audits domain.add and announces a domain change', async () => {
    const app = await newApp();
    events.length = 0;
    const d = await addDomain(app, '  Shop.Firma.CZ. ', actor, ENV);
    expect(d).toMatchObject({ hostname: 'shop.firma.cz', verified: false, isPrimary: false, certState: 'none' });
    expect(d.instructions.cname).toEqual({ name: 'shop.firma.cz', value: `${app.slug}.drobek.app` });
    expect(d.instructions.txt.name).toBe('_drobek.shop.firma.cz');
    expect(d.instructions.txt.value).toMatch(/^drobek-verify=[0-9a-f]{32}$/);
    expect(await auditActions('shop.firma.cz')).toEqual(['domain.add']);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.target, 'shop.firma.cz'));
    expect(row).toMatchObject({ actorKind: 'user', actorUserId: actor.userId, subjectType: 'domain', meta: { app: app.slug } });
    expect(events).toEqual([{ app_id: app.id, slug: app.slug, kind: 'domain' }]);
  });

  it('refuses www.drobek.app (and anything under APPS_DOMAIN / the dashboard host)', async () => {
    const app = await newApp();
    for (const h of ['www.drobek.app', 'drobek.app', `${app.slug}.drobek.app`]) {
      expect((await err(addDomain(app, h, actor, ENV)))?.code, h).toBe('hostname_not_allowed');
    }
    expect((await err(addDomain(app, '1.2.3.4', actor, ENV)))?.code).toBe('invalid_hostname');
  });

  it('the 4th domain of an app is limit_exceeded (DOMAINS_MAX_PER_APP default 3)', async () => {
    const app = await newApp();
    for (const h of ['a.limit.cz', 'b.limit.cz', 'c.limit.cz']) await addDomain(app, h, actor, ENV);
    const e = await err(addDomain(app, 'd.limit.cz', actor, ENV));
    expect(e).toBeInstanceOf(DomainsError);
    expect(e?.code).toBe('limit_exceeded');
    expect(e?.details).toEqual({ limit: 'DOMAINS_MAX_PER_APP', value: 3 });
    // The env knob moves it.
    const other = await newApp();
    await addDomain(other, 'one.limit.cz', actor, { ...ENV, DOMAINS_MAX_PER_APP: '1' });
    expect((await err(addDomain(other, 'two.limit.cz', actor, { ...ENV, DOMAINS_MAX_PER_APP: '1' })))?.code).toBe('limit_exceeded');
  });

  it('the same name twice on one app is already_added', async () => {
    const app = await newApp();
    await addDomain(app, 'twice.cz', actor, ENV);
    expect((await err(addDomain(app, 'TWICE.cz', actor, ENV)))?.code).toBe('already_added');
  });

  it('an unverified claim elsewhere never blocks the real owner; a verified one does (domain_taken)', async () => {
    const squatter = await newApp();
    const owner = await newApp();
    await addDomain(squatter, 'contested.cz', actor, ENV);
    const mine = await addDomain(owner, 'contested.cz', actor, ENV);
    const zone = {
      txt: { '_drobek.contested.cz': [mine.instructions.txt.value] },
      cname: { 'contested.cz': [`${owner.slug}.drobek.app`] },
    };
    const out = await verifyDomain(owner, mine.id, actor, { env: ENV, resolver: zoneResolver(zone) });
    expect(out.domain.verified).toBe(true);
    const late = await newApp();
    expect((await err(addDomain(late, 'contested.cz', actor, ENV)))?.code).toBe('domain_taken');
    // The squatter's pending row can never verify: its token is not in DNS, and the name is taken.
    const [sq] = await listDomains(squatter, ENV);
    expect((await err(verifyDomain(squatter, sq.id, actor, { env: ENV, resolver: zoneResolver(zone) })))).toBeNull();
    expect((await listDomains(squatter, ENV))[0].verified).toBe(false);
    // Host resolution follows the VERIFIED row.
    expect(await resolveCustomHost('contested.cz')).toEqual({ slug: owner.slug });
  });
});

describe('verifyDomain', () => {
  it('without the TXT → not verified, the reason stored, nothing audited', async () => {
    const app = await newApp();
    const d = await addDomain(app, 'notxt.cz', actor, ENV);
    const zone = { txt: {}, cname: { 'notxt.cz': [`${app.slug}.drobek.app`] } };
    const out = await verifyDomain(app, d.id, actor, { env: ENV, resolver: zoneResolver(zone) });
    expect(out.domain.verified).toBe(false);
    expect(out.check).toMatchObject({ ok: false, txt: 'missing', target: 'ok' });
    expect(out.domain.lastError).toContain('_drobek.notxt.cz');
    expect(out.domain.lastCheckAt).not.toBeNull();
    expect(await auditActions('notxt.cz')).toEqual(['domain.add']);
    // Registered but unverified: the apps side 404s, Caddy gets no certificate.
    expect(await resolveCustomHost('notxt.cz')).toEqual({ slug: null });
    expect(await customDomainAskAllowed('notxt.cz')).toBe(false);
  });

  it('with both records → verified, audited once, served + allowed by the ask (cert_state requested)', async () => {
    const app = await newApp();
    const d = await addDomain(app, 'both.cz', actor, ENV);
    const zone = { txt: { '_drobek.both.cz': [d.instructions.txt.value] }, cname: { 'both.cz': [`${app.slug}.drobek.app.`] } };
    events.length = 0;
    const out = await verifyDomain(app, d.id, actor, { env: ENV, resolver: zoneResolver(zone) });
    expect(out).toMatchObject({ newlyVerified: true, unverified: false });
    expect(out.domain).toMatchObject({ verified: true, lastError: null });
    expect(events).toEqual([{ app_id: app.id, slug: app.slug, kind: 'domain' }]);
    // Checking again keeps verified_at and does not audit twice.
    const again = await verifyDomain(app, d.id, actor, { env: ENV, resolver: zoneResolver(zone) });
    expect(again.newlyVerified).toBe(false);
    expect(again.domain.verifiedAt?.getTime()).toBe(out.domain.verifiedAt?.getTime());
    expect(await auditActions('both.cz')).toEqual(['domain.add', 'domain.verify']);

    expect(await resolveCustomHost('both.cz')).toEqual({ slug: app.slug });
    expect(await resolveCustomHost('unknown.cz')).toBeNull();
    expect(await customDomainAskAllowed('both.cz')).toBe(true);
    const [row] = await db.select().from(domains).where(eq(domains.id, d.id));
    expect(row.certState).toBe('requested');
  });

  it('a CNAME to another app is not enough', async () => {
    const app = await newApp();
    const d = await addDomain(app, 'wrongcname.cz', actor, ENV);
    const zone = { txt: { '_drobek.wrongcname.cz': [d.instructions.txt.value] }, cname: { 'wrongcname.cz': ['someone-else.drobek.app'] } };
    const out = await verifyDomain(app, d.id, actor, { env: ENV, resolver: zoneResolver(zone) });
    expect(out.check).toMatchObject({ ok: false, target: 'wrong' });
  });

  it('a domain id of another app is not_found', async () => {
    const a = await newApp();
    const b = await newApp();
    const d = await addDomain(a, 'mine-only.cz', actor, ENV);
    expect((await err(verifyDomain(b, d.id, actor, { env: ENV, resolver: zoneResolver({ txt: {}, cname: {} }) })))?.code).toBe('not_found');
    expect((await err(removeDomain(b, d.id, actor)))?.code).toBe('not_found');
  });

  it('a soft-deleted app no longer serves its verified domain', async () => {
    const app = await newApp();
    const d = await addDomain(app, 'gone-app.cz', actor, ENV);
    const zone = { txt: { '_drobek.gone-app.cz': [d.instructions.txt.value] }, cname: { 'gone-app.cz': [`${app.slug}.drobek.app`] } };
    await verifyDomain(app, d.id, actor, { env: ENV, resolver: zoneResolver(zone) });
    await db.update(apps).set({ deletedAt: new Date() }).where(eq(apps.id, app.id));
    expect(await resolveCustomHost('gone-app.cz')).toEqual({ slug: null });
    expect(await customDomainAskAllowed('gone-app.cz')).toBe(false);
  });
});

describe('primary domain + remove', () => {
  it('only a verified domain can be primary; one per app; remove audits domain.remove and stops serving', async () => {
    const app = await newApp();
    const a = await addDomain(app, 'primary-a.cz', actor, ENV);
    const b = await addDomain(app, 'primary-b.cz', actor, ENV);
    expect((await err(setPrimaryDomain(app, a.id, actor)))?.code).toBe('not_verified');
    const zone = {
      txt: { '_drobek.primary-a.cz': [a.instructions.txt.value], '_drobek.primary-b.cz': [b.instructions.txt.value] },
      cname: { 'primary-a.cz': [`${app.slug}.drobek.app`], 'primary-b.cz': [`${app.slug}.drobek.app`] },
    };
    await verifyDomain(app, a.id, actor, { env: ENV, resolver: zoneResolver(zone) });
    await verifyDomain(app, b.id, actor, { env: ENV, resolver: zoneResolver(zone) });
    await setPrimaryDomain(app, a.id, actor);
    expect(await primaryDomainOf(app.id)).toBe('primary-a.cz');
    await setPrimaryDomain(app, b.id, actor);
    expect(await primaryDomainOf(app.id)).toBe('primary-b.cz');
    expect((await listDomains(app, ENV)).filter((d) => d.isPrimary).map((d) => d.hostname)).toEqual(['primary-b.cz']);
    await setPrimaryDomain(app, null, actor);
    expect(await primaryDomainOf(app.id)).toBeNull();

    expect(await removeDomain(app, a.id, actor)).toEqual({ hostname: 'primary-a.cz' });
    expect(await auditActions('primary-a.cz')).toEqual(['domain.add', 'domain.verify', 'domain.primary', 'domain.remove']);
    expect(await resolveCustomHost('primary-a.cz')).toBeNull();
    expect(await customDomainAskAllowed('primary-a.cz')).toBe(false);
  });
});

describe('recheckDueDomains (the daily re-check)', () => {
  it('drops the verification when the TXT is gone, e-mails the owners once, audits domain.unverify', async () => {
    const app = await newApp();
    const d = await addDomain(app, 'recheck.cz', actor, ENV);
    const keep = await addDomain(app, 'keep.cz', actor, ENV);
    const flaky = await addDomain(app, 'flaky.cz', actor, ENV);
    const zone = {
      txt: {
        '_drobek.recheck.cz': [d.instructions.txt.value],
        '_drobek.keep.cz': [keep.instructions.txt.value],
        '_drobek.flaky.cz': [flaky.instructions.txt.value],
      } as Record<string, string[]>,
      cname: {
        'recheck.cz': [`${app.slug}.drobek.app`],
        'keep.cz': [`${app.slug}.drobek.app`],
        'flaky.cz': [`${app.slug}.drobek.app`],
      },
      fail: new Set<string>(),
    };
    const resolver = zoneResolver(zone);
    for (const x of [d, keep, flaky]) await verifyDomain(app, x.id, actor, { env: ENV, resolver });
    await setPrimaryDomain(app, d.id, actor);

    // Checked just now → not due.
    const sent: DomainLostNotice[] = [];
    const sendNotice = async (m: DomainLostNotice) => {
      sent.push(m);
    };
    const now = new Date();
    const before = await recheckDueDomains({ env: ENV, resolver, sendNotice, now: () => now });
    expect(before.checked).toBe(0);

    // A day later the owner deleted the TXT; the flaky zone's resolver fails.
    delete zone.txt['_drobek.recheck.cz'];
    zone.fail.add('_drobek.flaky.cz');
    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    // Only this app's domains are due (the other tests' verified ones were "just checked").
    await db.update(domains).set({ lastCheckAt: later }).where(ne(domains.appId, app.id));
    events.length = 0;
    const r = await recheckDueDomains({ env: ENV, resolver, sendNotice, now: () => later });
    expect(r).toMatchObject({ dropped: 1, transient: 1 });
    expect(r.checked).toBeGreaterThanOrEqual(3);

    const byHost = Object.fromEntries((await listDomains(app, ENV)).map((x) => [x.hostname, x]));
    expect(byHost['recheck.cz']).toMatchObject({ verified: false, isPrimary: false });
    expect(byHost['recheck.cz'].lastError).toContain('_drobek.recheck.cz');
    expect(byHost['keep.cz']).toMatchObject({ verified: true, lastError: null });
    expect(byHost['flaky.cz'].verified).toBe(true); // a resolver hiccup keeps it
    expect(byHost['flaky.cz'].lastError).toMatch(/could not be looked up/);
    expect(await resolveCustomHost('recheck.cz')).toEqual({ slug: null });
    expect(events).toEqual([{ app_id: app.id, slug: app.slug, kind: 'domain' }]);

    // Owners = editors + workspace-admins (never viewers), one message each.
    expect(sent.map((m) => m.to).sort()).toEqual(['editor@example.test', 'owner@example.test']);
    expect(sent[0].subject).toBe('Custom domain recheck.cz is no longer verified');
    expect(sent[0].text).toContain(`https://drobek.app/workspaces/firma/apps/${app.slug}/domains`);
    expect(sent[0].text).toContain(`CNAME recheck.cz → ${app.slug}.drobek.app`);

    const unverify = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.target, 'recheck.cz'), eq(auditLog.action, 'domain.unverify')));
    expect(unverify).toHaveLength(1);
    expect(unverify[0]).toMatchObject({ actorUserId: null, meta: { app: app.slug, by: 'dns_recheck' } });

    // The next sweep skips the unverified domain: no second e-mail.
    const evenLater = new Date(later.getTime() + 25 * 60 * 60 * 1000);
    await db.update(domains).set({ lastCheckAt: evenLater }).where(ne(domains.appId, app.id));
    await recheckDueDomains({ env: ENV, resolver, sendNotice, now: () => evenLater });
    expect(sent).toHaveLength(2);
  });
});
