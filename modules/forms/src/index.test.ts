/**
 * The forms module under createModuleTestContext(): real routes through the
 * production pipeline (rate limits, body types, rules), PGlite with the core
 * + forms migrations, e-mails captured by the test context.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apps, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { buildSdk, defineModule, isDefinedModule, loadModules, z } from '@drobek/modules';
import { createModuleTestContext, type ModuleTestContext } from '@drobek/modules/testing';
import forms, {
  FORMS_CONFIG_DEFAULTS,
  checkFormToken,
  formConfig,
  formsConfigSchema,
  formsConfirmRequired,
  formsKey,
  formSubmissions,
  ipHash,
  issueFormToken,
  notificationEmail,
  validateFields,
} from './index.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
const HOST = 'shop--preview.apps.localhost';
const MASTER = 'ab'.repeat(32);

let pg: PGlite;
let db: DB;
let appId: string;
let workspaceId: string;

beforeAll(async () => {
  process.env.DROBEK_MASTER_KEY = MASTER;
  process.env.PUBLIC_APP_URL = 'https://drobek.example';
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: forms.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_forms', migrationsSchema: 'drizzle' });
  const [ws] = await d.insert(workspaces).values({ kind: 'team', slug: 'forms-ws', name: 'Forms' }).returning();
  workspaceId = ws.id;
  const [app] = await d.insert(apps).values({ workspaceId: ws.id, slug: 'shop', name: 'Bakery\r\nshop' }).returning();
  appId = app.id;
  db = d as unknown as DB;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await db.delete(formSubmissions);
});

const ADMIN = { kind: 'user', id: 'eu_admin', email: 'boss@example.com', role: 'admin' } as const;
const USER = { kind: 'user', id: 'eu_user', email: 'ana@example.com', role: 'user' } as const;

function ctx(opts: { config?: Record<string, unknown>; limits?: Record<string, number>; log?: ReturnType<typeof logger> } = {}): ModuleTestContext {
  return createModuleTestContext(forms, {
    db,
    app: { id: appId, slug: 'shop', workspaceId },
    config: opts.config,
    limits: opts.limits,
    owners: ['owner@example.com'],
    origin: `http://${HOST}`,
    ...(opts.log ? { log: opts.log } : {}),
  });
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A token of `form` issued `ageMs` ago. */
function token(form = 'contact', ageMs = 3_000, app = appId): string {
  return issueFormToken(formsKey()!, app, form, Date.now() - ageMs);
}

async function rows() {
  return db.select().from(formSubmissions);
}

describe('drobek-module-forms — shape and config', () => {
  it('requires the email module: alone it refuses the start, with email it loads', async () => {
    expect(isDefinedModule(forms)).toBe(true);
    expect(forms.requires).toEqual(['email']);
    const email = defineModule({ name: 'email', version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} });
    const importer = async (pkg: string) => ({ 'drobek-module-forms': { default: forms }, 'drobek-module-email': { default: email } })[pkg];
    await expect(loadModules({ DROBEK_MODULES: 'forms' }, { importer })).rejects.toThrow(/module "forms" requires the module "email"/);
    expect((await loadModules({ DROBEK_MODULES: 'email,forms' }, { importer })).map((m) => m.name)).toEqual(['email', 'forms']);
  });

  it('config: any form works with defaults; names validated; notify.emails changes wait for the owner', () => {
    expect(formsConfigSchema.parse(FORMS_CONFIG_DEFAULTS)).toEqual({ forms: {} });
    expect(formConfig(FORMS_CONFIG_DEFAULTS, 'contact')).toEqual({ rules: { submit: 'public' }, notify: { emails: [], owners: true } });
    expect(formConfig(FORMS_CONFIG_DEFAULTS, 'constructor')).toEqual({ rules: { submit: 'public' }, notify: { emails: [], owners: true } });
    const c = formsConfigSchema.parse({ forms: { contact: { notify: { emails: [' Sales@Example.com '] } } } });
    expect(c.forms.contact).toEqual({ rules: { submit: 'public' }, notify: { emails: ['sales@example.com'], owners: true } });
    expect(formsConfigSchema.safeParse({ forms: { 'Bad Name': {} } }).success).toBe(false);
    expect(formsConfigSchema.safeParse({ forms: { contact: { notify: { emails: ['nope'] } } } }).success).toBe(false);
    expect(formsConfigSchema.safeParse({ forms: { contact: { to: 'x@y.cz' } } }).success).toBe(false);
    expect(formsConfigSchema.safeParse({ forms: { contact: { rules: { submit: 'admin' } } } }).success).toBe(false);

    const none = formsConfigSchema.parse({});
    const added = formsConfigSchema.parse({ forms: { contact: { notify: { emails: ['a@b.cz'] } } } });
    expect(formsConfirmRequired(none, added)).toEqual(['forms.contact.notify.emails: [] → [a@b.cz] (who gets the "contact" submissions by e-mail)']);
    expect(formsConfirmRequired(added, none)).toEqual(['forms.contact.notify.emails: [a@b.cz] → [] (who gets the "contact" submissions by e-mail)']);
    const owners = formsConfigSchema.parse({ forms: { contact: { notify: { emails: ['a@b.cz'], owners: false }, rules: { submit: 'user' } } } });
    expect(formsConfirmRequired(added, owners)).toEqual([]);
  });

  it('bundles drobek.forms into sdk.js and exposes drobek/forms (<Form>) as an inline source', async () => {
    const sdk = await buildSdk([forms]);
    const js = sdk.js.toString('utf8');
    expect(js).toContain('"forms"');
    expect(js).toContain('/token');
    expect(js).not.toContain('function Form(');
    expect(sdk.inline['drobek/forms']).toContain('export function Form');
    expect(sdk.dts).toContain('readonly forms: forms.Api;');
  });

  it("the skill's React example compiles with the react-ts import map (one React, drobek → the SDK)", async () => {
    const { compile } = await import('@drobek/compile');
    const sdk = await buildSdk([forms]);
    const example = /```tsx\n([\s\S]*?)```/.exec(forms.skill.markdown)![1];
    const r = await compile(
      new Map([
        [
          'drobek.json',
          JSON.stringify({
            imports: {
              react: 'https://esm.sh/react@19.1.0',
              'react/jsx-runtime': 'https://esm.sh/react@19.1.0/jsx-runtime',
              'react-dom': 'https://esm.sh/react-dom@19.1.0?deps=react@19.1.0',
              'react-dom/client': 'https://esm.sh/react-dom@19.1.0/client?deps=react@19.1.0',
            },
          }),
        ],
        ['src/main.tsx', example],
        ['src/styles.css', 'body { margin: 0; }'],
      ]),
      { sdkUrl: sdk.url, sdkSources: sdk.inline }
    );
    expect(r.errors).toEqual([]);
    const out = r.outputs.get('main.js')!.toString('utf8');
    expect(out).toContain('function Form(');
    expect(out).toContain('"_hp"');
    expect(out).toContain(`from "${sdk.url}"`);
    expect(forms.skill.markdown.split('\n').length).toBeLessThanOrEqual(150);
  });
});

describe('the time token and the IP hash', () => {
  const key = formsKey({ DROBEK_MASTER_KEY: MASTER })!;
  it('bound to the app and the form, ≥ 2 s old, ≤ 2 h, unforgeable', () => {
    const now = 1_800_000_000_000;
    const t = issueFormToken(key, 'app_1', 'contact', now);
    expect(checkFormToken(key, t, 'app_1', 'contact', now + 2_000)).toEqual({ ok: true });
    expect(checkFormToken(key, t, 'app_1', 'contact', now + 500)).toEqual({ ok: false, reason: 'too_fast', waitMs: 1_500 });
    expect(checkFormToken(key, t, 'app_1', 'contact', now + 2 * 3_600_000 + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(checkFormToken(key, t, 'app_2', 'contact', now + 3_000)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkFormToken(key, t, 'app_1', 'order', now + 3_000)).toEqual({ ok: false, reason: 'invalid' });
    const other = formsKey({ DROBEK_MASTER_KEY: 'cd'.repeat(32) })!;
    expect(checkFormToken(other, t, 'app_1', 'contact', now + 3_000)).toEqual({ ok: false, reason: 'invalid' });
    const future = issueFormToken(key, 'app_1', 'contact', now + 60_000);
    expect(checkFormToken(key, future, 'app_1', 'contact', now)).toEqual({ ok: false, reason: 'invalid' });
    const [ts, mac] = t.split('.');
    expect(checkFormToken(key, `${(parseInt(ts, 36) - 5000).toString(36)}.${mac}`, 'app_1', 'contact', now + 3_000)).toEqual({ ok: false, reason: 'invalid' });
    for (const bad of [undefined, 42, '', 'x.y', `${t}x`, 'a'.repeat(100)]) expect(checkFormToken(key, bad, 'app_1', 'contact', now + 3_000).ok).toBe(false);
  });

  it('no master key → no forms key; IPs hashed with the key, per app', () => {
    expect(formsKey({})).toBeNull();
    expect(formsKey({ DROBEK_MASTER_KEY: 'short' })).toBeNull();
    const h = ipHash(key, 'app_1', '203.0.113.7')!;
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toContain('203');
    expect(ipHash(key, 'app_2', '203.0.113.7')).not.toBe(h);
    expect(ipHash(key, 'app_1', null)).toBeNull();
  });
});

describe('fields', () => {
  it('flat text / numbers / booleans / lists; reserved _names, objects, oversize refused with paths', () => {
    expect(validateFields({ name: 'Ana', age: 31, ok: true, none: null, tags: ['a', 'b'] })).toEqual({ name: 'Ana', age: 31, ok: true, none: null, tags: ['a', 'b'] });
    const fail = (data: Record<string, unknown>) => {
      try {
        validateFields(data);
      } catch (err) {
        return (err as { details: { path: string }[] }).details.map((d) => d.path);
      }
      return [];
    };
    expect(fail({})).toEqual(['(root)']);
    expect(fail({ _secret: 'x', nested: { a: 1 }, long: 'x'.repeat(10_001), n: Infinity, list: [1] })).toEqual(['_secret', 'nested', 'long', 'n', 'list']);
    expect(fail(JSON.parse('{"__proto__": "x"}'))).toEqual(['__proto__']);
    expect(fail(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, 'x'])))).toEqual(['(root)']);
  });

  it('the notification text lists the fields as plain text (multi-line values indented)', () => {
    const m = notificationEmail({
      appName: 'Bakery',
      form: 'contact',
      id: 'fs_1',
      fields: { name: 'Ana', message: 'line 1\r\n<script>alert(1)</script>', tags: ['a', 'b'] },
      host: HOST,
      link: 'https://drobek.example/workspaces/w/apps/shop',
      at: new Date('2026-09-23T10:00:00Z'),
    });
    expect(m.subject).toBe('New "contact" submission — Bakery');
    expect(m.text).toContain('name: Ana\nmessage:\n  line 1\n  <script>alert(1)</script>\ntags: a, b');
    expect(m.text).toContain(`Submission fs_1 · 2026-09-23T10:00:00.000Z · ${HOST}`);
    expect(m.text).toContain('Open the app in drobek: https://drobek.example/workspaces/w/apps/shop');
  });
});

describe('submissions', () => {
  it('GET token → a token for this app + form', async () => {
    const t = ctx();
    const r = await t.request('GET', '/contact/token');
    expect(r).toMatchObject({ status: 200, body: { min_wait_ms: 2000, expires_in: 7200 } });
    const tok = (r.body as { token: string }).token;
    expect(checkFormToken(formsKey()!, tok, appId, 'contact', Date.now() + 2_000)).toEqual({ ok: true });
    expect((await t.request('GET', '/Bad%20Name/token')).status).toBe(400);
  });

  it('a submission is stored and e-mailed to the owners (+ the confirmed notify.emails); answers { ok, id }', async () => {
    const t = ctx({ config: { forms: { contact: { notify: { emails: ['sales@example.com'] } } } } });
    const r = await t.request('POST', '/contact', {
      body: { _t: token(), _hp: '', name: 'Ana', message: '<script>alert(1)</script>' },
      headers: { host: HOST },
      clientIp: '203.0.113.7',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { id } = r.body as { ok: true; id: string };
    expect(r.body).toEqual({ ok: true, id: expect.stringMatching(/^fs_[0-9a-f]{24}$/) });
    const [row] = await rows();
    expect(row).toMatchObject({ id, appId, form: 'contact', data: { name: 'Ana', message: '<script>alert(1)</script>' }, userId: null });
    expect(row.ipHash).toBe(ipHash(formsKey()!, appId, '203.0.113.7'));
    expect(row.notifiedAt).not.toBeNull();
    expect(t.emails).toHaveLength(1);
    expect(t.emails[0]).toMatchObject({ to: ['sales@example.com', 'owner@example.com'], kind: 'notification', subject: 'New "contact" submission — Bakery shop' });
    expect(t.emails[0].text).toContain('message: <script>alert(1)</script>');
    expect(t.emails[0].text).toContain('https://drobek.example/workspaces/forms-ws/apps/shop');
  });

  it('notify.owners false and no emails → stored only', async () => {
    const t = ctx({ config: { forms: { quiet: { notify: { owners: false } } } } });
    const r = await t.request('POST', '/quiet', { body: { _t: token('quiet'), a: '1' } });
    expect(r.status).toBe(200);
    expect(t.emails).toHaveLength(0);
    const [row] = await rows();
    expect(row.notifiedAt).toBeNull();
  });

  it('a filled honeypot → 200 "ok", nothing stored or sent, a counter in the log', async () => {
    const log = logger();
    const t = ctx({ log });
    for (let i = 1; i <= 2; i++) {
      const r = await t.request('POST', '/contact', { body: { _t: token(), _hp: 'http://spam.example', name: 'bot' } });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, id: expect.stringMatching(/^fs_/) });
      expect(log.info).toHaveBeenLastCalledWith('forms: honeypot submission dropped', { event: 'forms_honeypot_drop', app_id: appId, form: 'contact', dropped_today: i });
    }
    // Even without a token: a bot is answered like a success.
    expect((await t.request('POST', '/contact', { body: { _hp: 'x', name: 'bot' } })).status).toBe(200);
    expect(await rows()).toHaveLength(0);
    expect(t.emails).toHaveLength(0);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('bot');
  });

  it('< 2 s after the token → 429 submitted_too_fast; no/forged token → 400 invalid_form_token', async () => {
    const t = ctx();
    const fast = await t.request('POST', '/contact', { body: { _t: token('contact', 200), name: 'Ana' } });
    expect(fast.status).toBe(429);
    expect(fast.body).toMatchObject({ error: 'submitted_too_fast', details: { min_wait_ms: 2000 } });
    expect(fast.headers['Retry-After']).toBe('2');
    const none = await t.request('POST', '/contact', { body: { name: 'Ana' } });
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({ error: 'invalid_form_token', details: { reason: 'invalid' } });
    const other = await t.request('POST', '/contact', { body: { _t: token('order'), name: 'Ana' } });
    expect(other.body).toMatchObject({ error: 'invalid_form_token' });
    const old = await t.request('POST', '/contact', { body: { _t: token('contact', 3 * 3_600_000), name: 'Ana' } });
    expect(old.body).toMatchObject({ error: 'invalid_form_token', details: { reason: 'expired' } });
    expect(await rows()).toHaveLength(0);
  });

  it('the 11th submission from one IP within an hour → 429 rate_limited', async () => {
    const t = ctx({ config: { forms: { burst: { notify: { owners: false } } } } });
    const _t = token('burst');
    for (let i = 0; i < 10; i++) {
      expect((await t.request('POST', '/burst', { body: { _t, n: i }, clientIp: '198.51.100.1' })).status, `#${i + 1}`).toBe(200);
    }
    const over = await t.request('POST', '/burst', { body: { _t, n: 10 }, clientIp: '198.51.100.1' });
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ error: 'rate_limited' });
    // Another visitor is not affected.
    expect((await t.request('POST', '/burst', { body: { _t, n: 11 }, clientIp: '198.51.100.2' })).status).toBe(200);
    expect(await rows()).toHaveLength(11);
  });

  it('FORMS_PER_APP_PER_DAY → 429 limit_exceeded', async () => {
    const t = ctx({ limits: { FORMS_PER_APP_PER_DAY: 2 } });
    for (let i = 0; i < 2; i++) expect((await t.request('POST', '/contact', { body: { _t: token(), n: i }, clientIp: `192.0.2.${i}` })).status).toBe(200);
    const over = await t.request('POST', '/contact', { body: { _t: token(), n: 3 }, clientIp: '192.0.2.9' });
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ error: 'limit_exceeded', details: { limit: 'FORMS_PER_APP_PER_DAY', value: 2 } });
  });

  it('multipart/form-data (text fields) works; a file part → 415; bad fields → 400; > 32 KiB → 413', async () => {
    const t = ctx();
    const B = 'formBoundary123';
    const part = (k: string, v: string, extra = '') => `--${B}\r\nContent-Disposition: form-data; name="${k}"${extra}\r\n\r\n${v}\r\n`;
    const headers = { 'content-type': `multipart/form-data; boundary=${B}` };
    const ok = await t.request('POST', '/contact', {
      rawBody: part('_t', token()) + part('_hp', '') + part('name', 'Ana') + part('topic', 'a') + part('topic', 'b') + `--${B}--\r\n`,
      headers,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await rows())[0].data).toEqual({ name: 'Ana', topic: ['a', 'b'] });
    const file = await t.request('POST', '/contact', { rawBody: part('_t', token()) + part('cv', '%PDF', '; filename="cv.pdf"') + `--${B}--\r\n`, headers });
    expect(file.status).toBe(415);
    const nested = await t.request('POST', '/contact', { body: { _t: token(), who: { a: 1 } } });
    expect(nested.status).toBe(400);
    expect(nested.body).toMatchObject({ error: 'invalid_request', details: [{ path: 'who' }] });
    const big = await t.request('POST', '/contact', { body: { _t: token(), text: 'x'.repeat(33 * 1024) } });
    expect(big.status).toBe(413);
    expect(await rows()).toHaveLength(1);
  });

  it('rules.submit: user → anonymous 401; a signed-in user is stored with their id', async () => {
    const t = ctx({ config: { forms: { members: { rules: { submit: 'user' }, notify: { owners: false } } } } });
    const anon = await t.request('POST', '/members', { body: { _t: token('members'), a: '1' } });
    expect(anon.status).toBe(401);
    t.setPrincipal(USER);
    expect((await t.request('POST', '/members', { body: { _t: token('members'), a: '1' } })).status).toBe(200);
    expect((await rows())[0].userId).toBe(USER.id);
  });

  it('a POST without X-Drobek-SDK or from another origin → 403 csrf_rejected', async () => {
    const t = ctx();
    const noHeader = await t.request('POST', '/contact', { body: { _t: token(), a: '1' }, headers: { 'x-drobek-sdk': '' } });
    expect(noHeader.status).toBe(403);
    const foreign = await t.request('POST', '/contact', { body: { _t: token(), a: '1' }, headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
  });
});

describe('reading submissions (admins only)', () => {
  async function seed(t: ModuleTestContext, n: number, extra: Record<string, unknown> = {}) {
    for (let i = 0; i < n; i++) {
      const r = await t.request('POST', '/contact', { body: { _t: token(), n: i, ...extra }, clientIp: `10.0.0.${i}` });
      expect(r.status).toBe(200);
      await new Promise((res) => setTimeout(res, 2));
    }
  }

  it('anonymous 401, user 403, admin: newest first, paginated, no-store', async () => {
    const t = ctx({ config: { forms: { contact: { notify: { owners: false } } } } });
    await seed(t, 3);
    expect((await t.request('GET', '/contact/submissions')).status).toBe(401);
    t.setPrincipal(USER);
    expect((await t.request('GET', '/contact/submissions')).status).toBe(403);
    expect((await t.request('GET', '/contact/submissions.csv')).status).toBe(403);
    t.setPrincipal(ADMIN);
    const p1 = await t.request('GET', '/contact/submissions', { query: { limit: '2' } });
    expect(p1.status).toBe(200);
    expect(p1.headers['Cache-Control']).toBe('no-store');
    const b1 = p1.body as { submissions: { data: { n: number } }[]; next_cursor: string };
    expect(b1.submissions.map((s) => s.data.n)).toEqual([2, 1]);
    const p2 = await t.request('GET', '/contact/submissions', { query: { limit: '2', before: b1.next_cursor } });
    const b2 = p2.body as { submissions: { data: { n: number } }[]; next_cursor: string | null };
    expect(b2.submissions.map((s) => s.data.n)).toEqual([0]);
    expect(b2.next_cursor).toBeNull();
    expect((await t.request('GET', '/contact/submissions', { query: { before: 'garbage' } })).status).toBe(400);
    expect((await t.request('GET', '/other/submissions')).body).toMatchObject({ submissions: [] });
  });

  it('CSV: attachment, formula injection neutralized, audit export (no values)', async () => {
    const t = ctx({ config: { forms: { contact: { notify: { owners: false } } } } });
    await seed(t, 1, { name: '=1+1', note: '@SUM(A1)', tab: '\tx', plain: 'a,"b"' });
    t.setPrincipal(ADMIN);
    const r = await t.request('GET', '/contact/submissions.csv');
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['Content-Disposition']).toBe('attachment; filename="contact-submissions.csv"');
    expect(r.headers['Cache-Control']).toBe('no-store');
    const [head, line] = String(r.body).split('\r\n');
    expect(head).toBe('id,created_at,n,name,note,plain,tab');
    expect(line).toContain(",'=1+1,'@SUM(A1),\"a,\"\"b\"\"\",'\tx");
    expect(t.audits).toEqual([{ action: 'forms.export', meta: { form: 'contact', rows: 1 } }]);
  });
});
