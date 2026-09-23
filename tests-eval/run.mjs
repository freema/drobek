#!/usr/bin/env node
// @ts-check
/**
 * tests-eval/run.mjs (NSO-308) — the MANUAL agent eval: a clean Claude Code
 * session with ONLY the drobek MCP builds three reference apps against a
 * running drobek stack, then the harness checks what came out. Never in CI
 * (it costs model tokens and needs the local stack + Mailpit).
 *
 *   node tests-eval/run.mjs --self-check   parsers on the fixtures (no network, no Claude)
 *   node tests-eval/run.mjs --dry-run      prerequisites + the plan (no writes anywhere)
 *   node tests-eval/run.mjs [--only a,b,c] [--mode mcp|plugin]
 *
 * See tests-eval/README.md for the prerequisites, the environment and the metrics.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findApiMisuse, formNameOf, parseSdkDts, parseTranscript, renderResults, unknownToolCalls } from './lib.mjs';

/**
 * @typedef {import('./lib.mjs').Transcript} Transcript
 * @typedef {import('./lib.mjs').EvalRow} EvalRow
 * @typedef {{ name: string, ok: boolean, detail?: string }} Check
 * @typedef {{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }} Raw
 * @typedef {{ app_id: string, name: string, slug: string, workspace: string, preview_url: string, published_url?: string, latest_version: number, compile_status: string | null }} AppSummary
 * @typedef {{ owner: string, member: string, stamp: string, workspace: string, secret: string, mcp: Mcp, dashboard: any, browser: any }} Ctx
 * @typedef {{ id: string, app: string, prompt: (ctx: Ctx) => string, verify: (ctx: Ctx, app: AppSummary, files: Map<string, string>) => Promise<Check[]> }} Scenario
 * @typedef {{ call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean, json: any, text: string }>, tools: string[], close: () => Promise<void> }} Mcp
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RESULTS = join(HERE, 'results');
const FIXTURES = join(HERE, 'fixtures');
const MODULES = ['auth', 'data', 'forms', 'email', 'files', 'proxy'];

const { values: flags } = parseArgs({
  options: {
    'self-check': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    mode: { type: 'string', default: 'mcp' },
    only: { type: 'string', default: 'a,b,c' },
    keep: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const ENV = {
  url: (process.env.DROBEK_URL ?? 'http://localhost:3041').replace(/\/+$/, ''),
  mailpit: (process.env.MAILPIT_URL ?? 'http://localhost:8025').replace(/\/+$/, ''),
  apiKey: process.env.DROBEK_API_KEY?.trim() || null,
  email: process.env.EVAL_EMAIL?.trim().toLowerCase() || null,
  claude: process.env.CLAUDE_BIN ?? 'claude',
  model: process.env.EVAL_MODEL?.trim() || null,
  budgetUsd: process.env.EVAL_MAX_BUDGET_USD ?? '5',
  timeoutMs: Number(process.env.EVAL_TIMEOUT_MS ?? 20 * 60_000),
  tools: process.env.EVAL_TOOLS ?? '',
  bare: process.env.EVAL_BARE === '1',
  container: process.env.EVAL_CONTAINER ?? 'drobek',
  pluginDir: resolve(process.env.DROBEK_PLUGIN_DIR ?? join(REPO, '..', 'drobek-plugin', 'plugins', 'drobek')),
  echoBase: process.env.EVAL_ECHO_BASE ?? 'http://proxy-echo',
};
const MODE = flags.mode === 'plugin' ? 'plugin' : 'mcp';
const SERVER = MODE === 'plugin' ? 'mcp__plugin_drobek_drobek' : 'mcp__drobek';
const ONLY = String(flags.only).split(',').map((s) => s.trim()).filter(Boolean);

// ── the three reference apps ────────────────────────────────────────────────

const TAIL = 'Work only through the drobek tools. Do not publish. When the preview works, reply with its preview URL and one sentence on anything the owner still has to confirm in the drobek dashboard.';

/** @type {Scenario[]} */
const SCENARIOS = [
  {
    id: 'a',
    app: 'contact-form',
    prompt: (c) =>
      `Build a contact page for my bakery "Eval Bakery ${c.stamp}" in drobek. Visitors fill in their name, e-mail and a message; every message is e-mailed to me, the app owner. Show a thank-you note after sending. ${TAIL}`,
    verify: verifyContact,
  },
  {
    id: 'b',
    app: 'team-list-admin',
    prompt: (c) =>
      `Build a team shopping list "Eval List ${c.stamp}" in drobek. Only ${c.member} and I may sign in. Everyone signed in sees the list; only admins (that is me, the app owner) can add and remove items. ${TAIL}`,
    verify: verifyTeamList,
  },
  {
    id: 'c',
    app: 'proxy-call',
    prompt: (c) =>
      `My drobek workspace already has an external API registered as the upstream "echo" (its key is set). Build an app "Eval Echo ${c.stamp}" in drobek: after signing in (only ${c.member} may sign in), the user presses "Call the API" and sees the JSON that GET /echo/hello on that upstream returns, with a loading and an error state. ${TAIL}`,
    verify: verifyProxy,
  },
];

// ── small utilities ─────────────────────────────────────────────────────────

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @param {unknown} err */
const msg = (err) => (err instanceof Error ? err.message : String(err));
/** @param {string} name @param {boolean} ok @param {string} [detail] @returns {Check} */
const check = (name, ok, detail) => (detail ? { name, ok, detail } : { name, ok });

/**
 * One HTTP request. A `*.localhost` host goes to 127.0.0.1 with an explicit
 * Host header (Node does not resolve `*.localhost` everywhere).
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [opts]
 * @returns {Promise<Raw>}
 */
function http(url, opts = {}) {
  const u = new URL(url);
  const loopback = u.hostname === 'localhost' || u.hostname.endsWith('.localhost');
  const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolveRes, reject) => {
    const req = send(
      {
        host: loopback ? '127.0.0.1' : u.hostname,
        port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? 'GET',
        headers: { ...opts.headers, Host: u.host },
        setHost: false,
        ...(u.protocol === 'https:' ? { servername: u.hostname } : {}),
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolveRes({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.setTimeout(20_000, () => req.destroy(new Error(`timeout: ${url}`)));
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** @param {string} text */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Mailpit ─────────────────────────────────────────────────────────────────

/** @param {string} email @returns {Promise<{ ID: string, Subject: string }[]>} */
async function mailsTo(email) {
  const r = await http(`${ENV.mailpit}/api/v1/messages?limit=200`);
  const body = parseJson(r.body);
  /** @type {any[]} */
  const list = Array.isArray(body?.messages) ? body.messages : [];
  return list
    .filter((m) => (m.To ?? []).some((/** @type {any} */ t) => String(t.Address ?? '').toLowerCase() === email))
    .map((m) => ({ ID: String(m.ID), Subject: String(m.Subject ?? '') }));
}

/** @param {string} id @returns {Promise<{ Subject: string, Text: string }>} */
async function mailDetail(id) {
  const d = parseJson((await http(`${ENV.mailpit}/api/v1/message/${id}`)).body) ?? {};
  return { Subject: String(d.Subject ?? ''), Text: String(d.Text ?? '') };
}

/**
 * The first mail to `email` that is not in `seen` and matches `test`.
 * @param {string} email @param {Set<string>} seen @param {(m: { Subject: string, Text: string }) => boolean} test
 */
async function pollMail(email, seen, test, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const m of await mailsTo(email)) {
      if (seen.has(m.ID)) continue;
      const d = await mailDetail(m.ID);
      if (test(d)) return d;
    }
    await sleep(500);
  }
  return null;
}

/** @param {string} email */
async function seenIds(email) {
  return new Set((await mailsTo(email)).map((m) => m.ID));
}

/** @param {string} email @param {Set<string>} seen */
async function pollCode(email, seen) {
  const mail = await pollMail(email, seen, (d) => /\b\d{6}\b/.test(`${d.Subject}\n${d.Text}`));
  const m = mail ? /\b(\d{6})\b/.exec(`${mail.Subject}\n${mail.Text}`) : null;
  if (!m) throw new Error(`no sign-in code for ${email} in Mailpit within 30 s`);
  return m[1];
}

// ── the drobek side: dashboard (Playwright), API key, MCP client ────────────

function e2eRequire() {
  return createRequire(join(REPO, 'tests-e2e', 'package.json'));
}

/** Sign in to the dashboard with the e-mail code; returns the browser context. @param {any} browser @param {string} email */
async function dashboardLogin(browser, email) {
  const ctx = await browser.newContext({ baseURL: ENV.url });
  const page = await ctx.newPage();
  const seen = await seenIds(email);
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.waitForURL(/\/login\/verify/);
  await page.getByLabel('Code').fill(await pollCode(email, seen));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/me$/);
  await page.close();
  return ctx;
}

/** A read/write/publish key for `email` from the dev container's CLI (printed once, kept in memory only). @param {string} email */
function mintApiKey(email) {
  const r = spawnSync(
    'docker',
    ['exec', ENV.container, 'node', 'packages/oauth/dist/cli/api-key-create.js', '--email', email, '--name', 'eval', '--scopes', 'read,write,publish'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );
  const key = (r.stdout ?? '').trim();
  if (r.status !== 0 || !/^drk_\S+$/.test(key)) {
    throw new Error(`minting the eval API key failed (docker exec ${ENV.container}): ${(r.stderr ?? '').trim() || `exit ${r.status}`}`);
  }
  return key;
}

/** @param {string} bearer @returns {Promise<Mcp>} */
async function mcpConnect(bearer) {
  const req = e2eRequire();
  const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(new URL(`${ENV.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'drobek-eval', version: '0.0.0' });
  await client.connect(transport);
  const listed = await client.listTools();
  /** @type {string[]} */
  const tools = listed.tools.map((/** @type {{ name: string }} */ t) => t.name);
  return {
    tools,
    call: async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content?.[0]?.text ?? '';
      return { isError: Boolean(res.isError), json: res.structuredContent ?? parseJson(text) ?? { text }, text };
    },
    close: () => client.close(),
  };
}

/** Register the `echo` upstream (bearer secret) in the workspace through the dashboard form. @param {any} dashboard @param {string} ws @param {string} secret */
async function registerEcho(dashboard, ws, secret) {
  const page = await dashboard.newPage();
  try {
    await page.goto(`/workspaces/${ws}/upstreams`);
    const row = page.locator('[data-testid="upstream-row"][data-upstream-name="echo"]');
    if ((await row.count()) > 0) return 'already registered (its secret is whatever was set before)';
    await page.getByTestId('field-name').fill('echo');
    await page.getByTestId('field-baseurl').fill(ENV.echoBase);
    await page.getByTestId('field-methods').fill('GET');
    await page.getByTestId('field-paths').fill('/echo');
    await page.getByTestId('field-authtype').selectOption('bearer');
    await page.getByTestId('field-secret').fill(secret);
    await page.getByTestId('upstream-submit').click();
    await row.waitFor({ timeout: 15_000 });
    return 'registered';
  } finally {
    await page.close();
  }
}

/** Confirm every pending module change of the app, as the owner would in the dashboard. @param {any} dashboard @param {string} appId */
async function confirmPending(dashboard, appId) {
  /** @type {string[]} */
  const confirmed = [];
  for (const m of MODULES) {
    const r = await dashboard.request.post(`${ENV.url}/api/apps/${appId}/modules/${m}/confirm`, { headers: { Origin: ENV.url }, maxRedirects: 0 });
    if (r.status() === 200) confirmed.push(m);
  }
  return confirmed;
}

// ── app-host helpers (the end user's side) ──────────────────────────────────

/** @param {string} previewUrl */
const secureCookie = (previewUrl) => previewUrl.startsWith('https:');
/** @param {string} previewUrl @param {string} [cookie] */
function sdkHeaders(previewUrl, cookie) {
  /** @type {Record<string, string>} */
  const h = { 'Content-Type': 'application/json', 'X-Drobek-SDK': '1', Origin: new URL(previewUrl).origin };
  if (cookie) h.Cookie = cookie;
  return h;
}

/**
 * send-code → the Mailpit code → verify on the app's host.
 * @param {string} previewUrl @param {string} email
 * @returns {Promise<{ ok: true, cookie: string, value: string, user: any } | { ok: false, detail: string }>}
 */
async function appSignIn(previewUrl, email) {
  const seen = await seenIds(email);
  const sent = await http(`${previewUrl}/__drobek/v1/auth/send-code`, { method: 'POST', headers: sdkHeaders(previewUrl), body: JSON.stringify({ email }) });
  if (sent.status !== 200) return { ok: false, detail: `send-code ${sent.status} ${sent.body.slice(0, 200)}` };
  const code = await pollCode(email, seen);
  const verified = await http(`${previewUrl}/__drobek/v1/auth/verify`, { method: 'POST', headers: sdkHeaders(previewUrl), body: JSON.stringify({ email, code }) });
  if (verified.status !== 200) return { ok: false, detail: `verify ${verified.status} ${verified.body.slice(0, 200)}` };
  const sc = verified.headers['set-cookie'];
  const m = /((?:__Host-)?drobek_eu=([0-9a-f]{64}))/.exec((Array.isArray(sc) ? sc : sc ? [sc] : []).join('\n'));
  if (!m) return { ok: false, detail: 'verify set no session cookie' };
  return { ok: true, cookie: m[1], value: m[2], user: parseJson(verified.body)?.user ?? null };
}

/** @param {string} previewUrl @param {string} cookie */
async function whoAmI(previewUrl, cookie) {
  return parseJson((await http(`${previewUrl}/__drobek/v1/auth/me`, { headers: { Cookie: cookie } })).body)?.user ?? null;
}

/** A browser page on the preview; collects page errors. @param {any} browser @param {string} previewUrl @param {string} [cookieValue] */
async function openPreview(browser, previewUrl, cookieValue) {
  const ctx = await browser.newContext();
  if (cookieValue) {
    await ctx.addCookies([{ name: secureCookie(previewUrl) ? '__Host-drobek_eu' : 'drobek_eu', value: cookieValue, url: previewUrl }]);
  }
  const page = await ctx.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (/** @type {Error} */ e) => errors.push(e.message));
  return { ctx, page, errors };
}

// ── per-app checks ──────────────────────────────────────────────────────────

/** @type {Scenario['verify']} */
async function verifyContact(c, app, files) {
  /** @type {Check[]} */
  const out = [];
  const form = formNameOf(files);
  out.push(check('the app submits a drobek form (<Form name> or drobek.forms.submit)', form !== null, form ?? 'none found'));
  const { ctx, page, errors } = await openPreview(c.browser, app.preview_url);
  try {
    await page.goto(app.preview_url, { waitUntil: 'load' });
    await page.locator('input, textarea').first().waitFor({ timeout: 15_000 });
    await sleep(2_300); // the form's time token: a submit < 2 s after it → 429
    const seen = await seenIds(c.owner);
    const visitor = `eval-visitor-${c.stamp}@example.com`;
    const fields = page.locator('form input, form textarea');
    for (let i = 0; i < (await fields.count()); i++) {
      const f = fields.nth(i);
      const name = String((await f.getAttribute('name')) ?? '');
      const type = String((await f.getAttribute('type')) ?? 'text').toLowerCase();
      if (name.startsWith('_') || ['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(type)) continue;
      if (!(await f.isVisible()) || (await f.getAttribute('aria-hidden')) === 'true') continue;
      await f.fill(type === 'email' || /mail/i.test(name) ? visitor : `Eval ${c.stamp}`);
    }
    const res = page.waitForResponse((/** @type {any} */ r) => r.request().method() === 'POST' && r.url().includes('/__drobek/v1/forms/'), { timeout: 15_000 });
    await page.locator('form button[type="submit"], form button:not([type]), form input[type="submit"]').first().click();
    const submitted = await res;
    out.push(check('a visitor submits the form in a browser → 200', submitted.status() === 200, `POST ${new URL(submitted.url()).pathname} → ${submitted.status()}`));
    const mail = await pollMail(c.owner, seen, (d) => /submission/i.test(d.Subject) && d.Text.includes(c.stamp));
    out.push(check('the owner gets the submission by e-mail (Mailpit)', mail !== null, mail ? mail.Subject : 'no mail to the owner within 30 s'));
    await sleep(500);
    out.push(check('no page errors in the browser', errors.length === 0, errors.slice(0, 3).join(' | ')));
  } catch (err) {
    out.push(check('the contact form works in a browser', false, msg(err)));
  } finally {
    await ctx.close();
  }
  return out;
}

/** @param {Map<string, string>} files */
function collectionsOf(files) {
  const names = new Set();
  for (const text of files.values()) {
    for (const m of text.matchAll(/\bcollection\s*(?:<[^>()]*>)?\s*\(\s*['"]([a-z0-9][a-z0-9_-]*)['"]/g)) names.add(m[1]);
  }
  return [...names];
}

/** @type {Scenario['verify']} */
async function verifyTeamList(c, app, files) {
  /** @type {Check[]} */
  const out = [];
  const { ctx, page, errors } = await openPreview(c.browser, app.preview_url);
  try {
    await page.goto(app.preview_url, { waitUntil: 'load' });
    await page.getByLabel('Email').first().waitFor({ timeout: 15_000 });
    const button = await page.getByRole('button', { name: 'Send code' }).count();
    out.push(check('an anonymous visitor sees the <LoginGate> sign-in form', button > 0));
    out.push(check('no page errors in the browser', errors.length === 0, errors.slice(0, 3).join(' | ')));
  } catch (err) {
    out.push(check('an anonymous visitor sees the <LoginGate> sign-in form', false, msg(err)));
  } finally {
    await ctx.close();
  }

  const admin = await appSignIn(app.preview_url, c.owner);
  const adminMe = admin.ok ? await whoAmI(app.preview_url, admin.cookie) : null;
  out.push(check('the owner signs in as admin', adminMe?.role === 'admin', admin.ok ? `role ${adminMe?.role}` : admin.detail));
  const member = await appSignIn(app.preview_url, c.member);
  const memberMe = member.ok ? await whoAmI(app.preview_url, member.cookie) : null;
  out.push(check('the member signs in as user', memberMe?.role === 'user', member.ok ? `role ${memberMe?.role}` : member.detail));

  const cols = collectionsOf(files);
  out.push(check('the app stores the list in a drobek.data collection', cols.length > 0, cols.join(', ') || 'none found'));
  const col = cols[0];
  if (!col) return out;
  const base = `${app.preview_url}/__drobek/v1/data/${col}`;
  const anon = await http(base);
  out.push(check('anonymous → the list is not readable (401)', anon.status === 401, `GET → ${anon.status}`));
  if (member.ok) {
    const read = await http(base, { headers: { Cookie: member.cookie } });
    out.push(check('the member reads the list (200)', read.status === 200, `GET → ${read.status}`));
    const write = await http(base, { method: 'POST', headers: sdkHeaders(app.preview_url, member.cookie), body: JSON.stringify({ text: `member ${c.stamp}`, title: `member ${c.stamp}`, name: `member ${c.stamp}` }) });
    out.push(check('the member may NOT add items (403)', write.status === 403, `POST → ${write.status}`));
  }
  if (admin.ok) {
    const write = await http(base, { method: 'POST', headers: sdkHeaders(app.preview_url, admin.cookie), body: JSON.stringify({ text: `admin ${c.stamp}`, title: `admin ${c.stamp}`, name: `admin ${c.stamp}` }) });
    // 201 = stored; 422 = the rule let the admin through and the app's own schema wants other fields.
    out.push(check('the admin passes the create rule (201, or 422 from the schema)', write.status === 201 || write.status === 422, `POST → ${write.status}`));
  }
  return out;
}

/** @type {Scenario['verify']} */
async function verifyProxy(c, app) {
  /** @type {Check[]} */
  const out = [];
  const member = await appSignIn(app.preview_url, c.member);
  out.push(check('the member signs in', member.ok, member.ok ? undefined : member.detail));
  if (!member.ok) return out;
  const raw = await http(`${app.preview_url}/__drobek/v1/proxy/echo/echo/hello`, { headers: sdkHeaders(app.preview_url, member.cookie) });
  const echoed = parseJson(raw.body);
  out.push(check('GET /echo/hello through the proxy → 200', raw.status === 200, `→ ${raw.status}${raw.status === 200 ? '' : ` ${raw.body.slice(0, 160)}`}`));
  out.push(check('the upstream gets the injected bearer secret (never the page)', echoed?.headers?.authorization === `Bearer ${c.secret}`));
  const { ctx, page, errors } = await openPreview(c.browser, app.preview_url, member.value);
  try {
    const res = page.waitForResponse((/** @type {any} */ r) => r.url().includes('/__drobek/v1/proxy/echo/'), { timeout: 25_000 });
    await page.goto(app.preview_url, { waitUntil: 'load' });
    const button = page.getByRole('button', { name: /call|fetch|load|api|send|try/i }).first();
    await button.click({ timeout: 10_000 }).catch(() => undefined);
    const r = await res;
    out.push(check('the page calls the upstream through drobek.proxy in a browser → 200', r.status() === 200, `${new URL(r.url()).pathname} → ${r.status()}`));
    await page.getByText('/echo/hello').first().waitFor({ timeout: 10_000 });
    out.push(check('the page shows the upstream response', true));
    out.push(check('no page errors in the browser', errors.length === 0, errors.slice(0, 3).join(' | ')));
  } catch (err) {
    out.push(check('the page calls the upstream and shows its response', false, msg(err)));
  } finally {
    await ctx.close();
  }
  return out;
}

// ── one Claude Code session ─────────────────────────────────────────────────

/**
 * The claude CLI arguments for one clean session. The API key never lands in
 * a file: the MCP config says `${DROBEK_API_KEY}` and the child gets it in its
 * environment.
 * @param {string} prompt @param {string} dir the session's empty working directory
 */
function claudeArgs(prompt, dir) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'project', '--tools', ENV.tools, '--allowedTools', SERVER, '--max-budget-usd', ENV.budgetUsd];
  if (ENV.model) args.push('--model', ENV.model);
  if (ENV.bare) args.push('--bare');
  if (MODE === 'mcp') args.push('--strict-mcp-config', '--mcp-config', join(dir, 'mcp.json'), '--disable-slash-commands');
  else args.push('--plugin-dir', join(dir, 'plugin'));
  return args;
}

const MCP_SERVER = () => ({ type: 'http', url: `${ENV.url}/mcp`, headers: { Authorization: 'Bearer ${DROBEK_API_KEY}' } });

/** @param {string} dir */
function prepareSessionDir(dir) {
  if (MODE === 'mcp') {
    writeFileSync(join(dir, 'mcp.json'), `${JSON.stringify({ mcpServers: { drobek: MCP_SERVER() } }, null, 2)}\n`);
    return;
  }
  const plugin = join(dir, 'plugin');
  cpSync(ENV.pluginDir, plugin, { recursive: true });
  writeFileSync(join(plugin, '.mcp.json'), `${JSON.stringify({ mcpServers: { drobek: MCP_SERVER() } }, null, 2)}\n`);
}

/** @param {string[]} args @param {string} cwd @param {string} key @param {string} transcriptPath */
function runClaude(args, cwd, key, transcriptPath) {
  return new Promise((resolveRun) => {
    const out = createWriteStream(transcriptPath);
    let stdout = '';
    let stderr = '';
    const child = spawn(ENV.claude, args, { cwd, env: { ...process.env, DROBEK_API_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), ENV.timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      out.write(d);
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      out.end();
      resolveRun({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      out.end();
      resolveRun({ code: -1, stdout, stderr: `${stderr}\n${msg(err)}` });
    });
  });
}

// ── --self-check ────────────────────────────────────────────────────────────

/** The parsers on the fixture transcript + fixture sdk.d.ts. Exit 0 = all as expected. */
function selfCheck() {
  const t = parseTranscript(readFileSync(join(FIXTURES, 'transcript.jsonl'), 'utf8'));
  const sdk = parseSdkDts(readFileSync(join(FIXTURES, 'sdk.d.ts'), 'utf8'));
  const final = t.files.get('app_fixture_1') ?? new Map();
  const all = t.writes.map((w) => /** @type {[string, string]} */ ([w.path, w.content]));
  const known = ['list_apps', 'create_app', 'write_files', 'skill_info'];
  const row = {
    app: 'contact-form', pass: true, writeFiles: t.writeFilesCount, toolCalls: t.toolCalls.length, toolErrors: 1, skills: ['forms'],
    misuse: findApiMisuse(all, sdk).map((m) => m.name), turns: t.result?.turns ?? null, costUsd: t.result?.costUsd ?? null,
    durationMs: t.result?.durationMs ?? null, checks: [check('preview answers 200', true)],
  };
  const md = renderResults({ date: '2026-01-01', target: 'fixture', mode: 'mcp', model: 'fixture', rows: [row] });
  /** @type {[string, unknown, unknown][]} */
  const cases = [
    ['write_files calls', t.writeFilesCount, 2],
    ['tool calls', t.toolCalls.map((c) => c.tool), ['skill_info', 'create_app', 'write_files', 'deploy', 'write_files']],
    ['tool errors', t.toolCalls.filter((c) => c.isError).map((c) => c.tool), ['deploy']],
    ['app ids', t.appIds, ['app_fixture_1']],
    ['preview url', t.previewUrls.get('app_fixture_1'), 'http://eval-contact-fixture--preview.apps.localhost:3041'],
    ['final files (delete applied)', [...final.keys()], ['src/main.tsx']],
    ['every write kept', t.writes.map((w) => w.path), ['src/main.tsx', 'src/old.ts', 'src/main.tsx']],
    ['skills read', t.toolCalls.filter((c) => c.tool === 'skill_info').map((c) => c.input?.name), ['forms']],
    ['misuse over every write', row.misuse, ['drobek.forms.send', "Wizard from 'drobek/forms'", '/__drobek/v1/payments']],
    ['misuse in the final files only', findApiMisuse(final, sdk).map((m) => m.name), ["Wizard from 'drobek/forms'", '/__drobek/v1/payments']],
    ['unknown tools', unknownToolCalls(t.toolCalls, known).map((m) => m.name), ['deploy']],
    ['form name', formNameOf(final), 'contact'],
    ['result', t.result, { ok: true, text: 'Preview: http://eval-contact-fixture--preview.apps.localhost:3041', turns: 6, costUsd: 0.4213, durationMs: 61234 }],
    ['parse errors', t.parseErrors, 0],
    ['sdk modules', [...sdk.modules.keys()].sort(), ['auth', 'data', 'email', 'files', 'forms', 'proxy']],
    ['sdk auth.me / data.collection / proxy.fetch', [sdk.modules.get('auth')?.has('me'), sdk.modules.get('data')?.has('collection'), sdk.modules.get('proxy')?.has('fetch')], [true, true, true]],
    ['sdk inline exports', [...(sdk.inline.get('forms') ?? [])].includes('Form') && [...(sdk.inline.get('auth') ?? [])].includes('LoginGate'), true],
    ['sdk root exports', ['drobek', 'DrobekError'].every((n) => sdk.root.has(n)), true],
    ['results table row', md.includes('| contact-form | PASS | 2 | 5 (1) | forms |'), true],
    ['results total', md.includes('Non-existent API uses in total: **3** (must be 0).'), true],
  ];
  let failed = 0;
  for (const [name, actual, expected] of cases) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`}`);
  }
  console.log(failed === 0 ? `self-check: all ${cases.length} passed` : `self-check: ${failed} of ${cases.length} FAILED`);
  return failed === 0 ? 0 : 1;
}

// ── --dry-run ───────────────────────────────────────────────────────────────

/** Prerequisites + the plan; nothing is created anywhere. */
async function dryRun() {
  /** @type {Check[]} */
  const checks = [];
  const v = spawnSync(ENV.claude, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  checks.push(check(`Claude Code CLI (${ENV.claude})`, v.status === 0, (v.stdout ?? '').trim() || msg(v.error ?? `exit ${v.status}`)));
  try {
    const req = e2eRequire();
    req.resolve('@modelcontextprotocol/sdk/client/index.js');
    const { chromium } = req('@playwright/test');
    const exe = chromium.executablePath();
    checks.push(check('Playwright + MCP SDK (from tests-e2e)', existsSync(exe), existsSync(exe) ? exe : `no browser at ${exe} — pnpm -C tests-e2e exec playwright install chromium`));
  } catch (err) {
    checks.push(check('Playwright + MCP SDK (from tests-e2e)', false, `${msg(err)} — pnpm install`));
  }
  for (const [name, url] of [['drobek', `${ENV.url}/healthz`], ['Mailpit', `${ENV.mailpit}/api/v1/info`]]) {
    try {
      const r = await http(url);
      checks.push(check(`${name} at ${url}`, r.status === 200, `HTTP ${r.status}`));
    } catch (err) {
      checks.push(check(`${name} at ${url}`, false, msg(err)));
    }
  }
  if (ENV.apiKey) checks.push(check('DROBEK_API_KEY', /^drk_\S+$/.test(ENV.apiKey) && ENV.email !== null, ENV.email ? `for ${ENV.email}` : 'EVAL_EMAIL (the key owner) is required with a key'));
  else {
    const d = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', ENV.container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    checks.push(check(`container "${ENV.container}" for minting the key`, (d.stdout ?? '').trim() === 'true', (d.stderr ?? '').trim() || (d.stdout ?? '').trim() || msg(d.error)));
  }
  if (MODE === 'plugin') checks.push(check(`plugin dir ${ENV.pluginDir}`, existsSync(join(ENV.pluginDir, '.mcp.json'))));
  const unknown = ONLY.filter((id) => !SCENARIOS.some((s) => s.id === id));
  checks.push(check(`scenarios ${ONLY.join(',')}`, unknown.length === 0, unknown.length ? `unknown: ${unknown.join(', ')}` : undefined));

  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  const ctx = /** @type {Ctx} */ ({ owner: ENV.email ?? 'eval-owner-<stamp>@example.com', member: 'eval-member-<stamp>@example.com', stamp: '<stamp>' });
  console.log(`\nPlan (mode ${MODE}, target ${ENV.url}):`);
  console.log(`  1. ${ENV.email ? `sign in ${ENV.email}` : 'create a synthetic owner by signing in eval-owner-<stamp>@example.com'} to the dashboard (e-mail code from Mailpit)`);
  console.log(`  2. ${ENV.apiKey ? 'use DROBEK_API_KEY' : `mint a read,write,publish key (docker exec ${ENV.container} … api-key-create.js), kept in memory only`}`);
  console.log(`  3. register the workspace upstream "echo" → ${ENV.echoBase} (bearer secret, generated per run)`);
  for (const s of SCENARIOS.filter((x) => ONLY.includes(x.id))) {
    console.log(`  (${s.id}) ${s.app}: ${ENV.claude} ${claudeArgs('<prompt>', '<tmp>').map((a) => (a === '' ? '""' : a)).join(' ')}`);
    console.log(`      prompt: ${s.prompt(ctx)}`);
  }
  console.log(`  then: confirm pending module changes, check the preview, write tests-eval/results/<date>.md`);
  const ok = checks.every((c) => c.ok);
  console.log(ok ? '\ndry-run: ready' : '\ndry-run: NOT ready (fix the ✗ lines)');
  return ok ? 0 : 1;
}

// ── the full run ────────────────────────────────────────────────────────────

async function fullRun() {
  const stamp = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const date = new Date().toISOString().slice(0, 10);
  const owner = ENV.email ?? `eval-owner-${stamp}@example.com`;
  const member = `eval-member-${stamp}@example.com`;
  const secret = `sk-eval-${randomBytes(12).toString('hex')}`;
  mkdirSync(RESULTS, { recursive: true });

  const { chromium } = e2eRequire()('@playwright/test');
  const browser = await chromium.launch();
  /** @type {Mcp | null} */
  let mcp = null;
  /** @type {EvalRow[]} */
  const rows = [];
  try {
    console.log(`owner ${owner} — signing in to ${ENV.url}`);
    const dashboard = await dashboardLogin(browser, owner);
    const key = ENV.apiKey ?? mintApiKey(owner);
    mcp = await mcpConnect(key);
    const listed = await mcp.call('list_apps', {});
    /** @type {{ slug: string, kind: string }[]} */
    const workspaces = listed.json?.workspaces ?? [];
    const workspace = workspaces.find((w) => w.kind === 'personal')?.slug;
    if (!workspace) throw new Error(`list_apps returned no personal workspace: ${listed.text.slice(0, 200)}`);
    console.log(`workspace ${workspace}; upstream echo: ${await registerEcho(dashboard, workspace, secret)}`);
    /** @type {Ctx} */
    const ctx = { owner, member, stamp, workspace, secret, mcp, dashboard, browser };

    for (const s of SCENARIOS.filter((x) => ONLY.includes(x.id))) {
      console.log(`\n(${s.id}) ${s.app} — claude session …`);
      const before = new Set(((await mcp.call('list_apps', {})).json?.apps ?? []).map((/** @type {AppSummary} */ a) => a.app_id));
      const dir = mkdtempSync(join(tmpdir(), `drobek-eval-${s.id}-`));
      prepareSessionDir(dir);
      const transcriptPath = join(RESULTS, `${date}-${stamp}-${s.app}.jsonl`);
      const started = Date.now();
      const run = /** @type {{ code: number | null, stdout: string, stderr: string }} */ (await runClaude(claudeArgs(s.prompt(ctx), dir), dir, key, transcriptPath));
      if (!flags.keep) rmSync(dir, { recursive: true, force: true });
      const t = parseTranscript(run.stdout);
      /** @type {Check[]} */
      const checks = [check('the session finished', t.result?.ok === true, t.result ? t.result.text.slice(0, 200) : `exit ${run.code} ${run.stderr.slice(-300)}`)];

      const apps = /** @type {AppSummary[]} */ ((await mcp.call('list_apps', {})).json?.apps ?? []);
      const appId = t.appIds.find((id) => apps.some((a) => a.app_id === id)) ?? apps.find((a) => !before.has(a.app_id))?.app_id;
      const app = apps.find((a) => a.app_id === appId);
      checks.push(check('the agent created an app', app !== undefined, app ? `${app.slug} (v${app.latest_version}, compile ${app.compile_status})` : 'none'));
      /** @type {string[]} */
      let misuse = unknownToolCalls(t.toolCalls, mcp.tools).map((m) => `tool ${m.name}`);
      if (app) {
        const confirmed = await confirmPending(dashboard, app.app_id);
        checks.push(check('pending module changes confirmed by the owner', true, confirmed.join(', ') || 'none pending'));
        checks.push(check('the agent did not publish', app.published_url === undefined));
        const sdkDts = await http(`${app.preview_url}/__drobek/sdk.d.ts`);
        const sdk = parseSdkDts(sdkDts.body);
        const written = t.writes.filter((w) => w.appId === app.app_id).map((w) => /** @type {[string, string]} */ ([w.path, w.content]));
        misuse = [...misuse, ...findApiMisuse(written, sdk).map((m) => m.name)];
        const preview = await http(`${app.preview_url}/`);
        checks.push(check('the preview answers 200', preview.status === 200, `HTTP ${preview.status}`));
        try {
          checks.push(...(await s.verify(ctx, app, t.files.get(app.app_id) ?? new Map())));
        } catch (err) {
          checks.push(check('the app checks ran', false, msg(err)));
        }
        await sleep(2_000); // page errors reach get_logs within seconds
        const logs = await mcp.call('get_logs', { app_id: app.app_id, kind: 'runtime' });
        /** @type {{ message?: string }[]} */
        const entries = logs.json?.entries ?? [];
        checks.push(check('get_logs runtime: no browser errors', entries.length === 0, entries.map((e) => e.message ?? '').slice(0, 3).join(' | ')));
      }
      checks.push(check('non-existent API uses = 0', misuse.length === 0, misuse.join(', ')));
      rows.push({
        app: s.app,
        pass: checks.every((c) => c.ok),
        writeFiles: t.writeFilesCount,
        toolCalls: t.toolCalls.length,
        toolErrors: t.toolCalls.filter((c) => c.isError).length,
        skills: [...new Set(t.toolCalls.filter((c) => c.tool === 'skill_info' && c.input?.name).map((c) => String(c.input.name)))],
        misuse,
        turns: t.result?.turns ?? null,
        costUsd: t.result?.costUsd ?? null,
        durationMs: t.result?.durationMs ?? Date.now() - started,
        checks,
      });
      for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
  } finally {
    await mcp?.close().catch(() => undefined);
    await browser.close();
  }

  const md = renderResults({ date, target: ENV.url, mode: MODE, model: ENV.model ?? 'CLI default', rows });
  const base = join(RESULTS, `${date}-${stamp}`);
  writeFileSync(`${base}.md`, md);
  writeFileSync(`${base}.json`, `${JSON.stringify({ date, stamp, target: ENV.url, mode: MODE, model: ENV.model, rows }, null, 2)}\n`);
  console.log(`\n${md}\nwritten: ${base}.md (+ .json; transcripts ${base}-*.jsonl)`);
  return rows.length > 0 && rows.every((r) => r.pass) ? 0 : 1;
}

function help() {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(3, 13).join('\n').replace(/^ \* ?/gm, ''));
  return 0;
}

const code = flags.help ? help() : flags['self-check'] ? selfCheck() : flags['dry-run'] ? await dryRun() : await fullRun();
process.exit(code);
