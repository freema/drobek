/**
 * The agent half of scripts/selfhost-rehearsal.sh (M4-03) — NOT a Playwright
 * spec. Lives in tests-e2e/ for its @modelcontextprotocol/sdk dependency.
 *
 *   node tests-e2e/selfhost-rehearsal.mjs seed    create + write + publish an
 *        app over MCP (drk_ key), sign an end user in on the app host, upload
 *        a file (files module, read: public) → writes the state file
 *   node tests-e2e/selfhost-rehearsal.mjs verify  after restore: the same key
 *        lists the app, its production host serves the published marker and
 *        the file downloads byte for byte
 *
 * Env: BASE_URL (https://localhost:<port>), APPS_DOMAIN (apps.localhost:<port>),
 * API_KEY, MAILPIT_URL, STATE_FILE, CA_FILE (Caddy's local root; the SDK's fetch
 * trusts it through NODE_EXTRA_CA_CERTS, set by the caller).
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const BASE_URL = need('BASE_URL');
const APPS_DOMAIN = need('APPS_DOMAIN');
const API_KEY = need('API_KEY');
const STATE_FILE = need('STATE_FILE');
const CA = readFileSync(need('CA_FILE'));
const phase = process.argv[2];

const log = (msg) => process.stderr.write(`  ${msg}\n`);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
function check(ok, msg, detail) {
  if (!ok) throw new Error(`${msg}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  log(`✓ ${msg}`);
}

/** HTTPS to an app host: 127.0.0.1 + Host + SNI (*.localhost does not resolve everywhere). */
function appRequest(host, path, { method = 'GET', headers = {}, body } = {}) {
  const [hostname, port] = host.split(':');
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost');
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: loopback ? '127.0.0.1' : hostname,
        port: Number(port ?? 443),
        path,
        method,
        headers: { ...headers, Host: host },
        setHost: false,
        servername: hostname,
        ca: CA,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: bytes.toString('utf8'), bytes });
        });
      }
    );
    req.setTimeout(20_000, () => req.destroy(new Error(`timeout: https://${host}${path}`)));
    req.on('error', reject);
    req.end(body);
  });
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
  });
  const client = new Client({ name: 'drobek-selfhost-rehearsal', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  let json = res.structuredContent;
  if (!json) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { text };
    }
  }
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return json;
}

/** Mailpit: the newest 6-digit code sent to `email`. */
async function pollCode(email) {
  const mailpit = need('MAILPIT_URL');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const list = await (await fetch(`${mailpit}/api/v1/messages?limit=50`)).json();
    const msg = (list.messages ?? []).find((m) => (m.To ?? []).some((t) => t.Address?.toLowerCase() === email));
    if (msg) {
      const d = await (await fetch(`${mailpit}/api/v1/message/${msg.ID}`)).json();
      const m = /\b(\d{6})\b/.exec(`${d.Subject ?? ''}\n${d.Text ?? ''}`);
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no sign-in code for ${email} within 30 s`);
}

const BOUNDARY = '----drobekSelfhostRehearsal';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function seed() {
  const client = await connect();
  const marker = `selfhost-rehearsal-${randomBytes(6).toString('hex')}`;
  const created = await call(client, 'create_app', { name: `Rehearsal ${marker.slice(-6)}`, template: 'html' });
  check(Boolean(created.app_id && created.slug), `create_app → ${created.slug}`, created);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${marker}</title></head><body><h1 id="m">${marker}</h1></body></html>\n`;
  const written = await call(client, 'write_files', {
    app_id: created.app_id,
    files: [{ path: 'index.html', content: html }],
    reasoning: 'self-host rehearsal marker page',
  });
  check(written.compile?.ok === true, `write_files → v${written.version} compiled`, written.compile);

  const published = await call(client, 'publish', { app_id: created.app_id });
  check(Boolean(published.published_url), `publish → ${published.published_url} (v${published.published_version})`, published);
  const prodHost = new URL(published.published_url).host;
  const prod = await appRequest(prodHost, '/');
  check(prod.status === 200 && prod.body.includes(marker), `the production host serves the marker (HTTP ${prod.status})`, prod.body.slice(0, 200));

  // The files module: an end user signs in on the app host and uploads.
  const endUser = `rehearsal-${marker.slice(-6)}@example.com`;
  await call(client, 'configure_module', { app_id: created.app_id, module: 'auth', config: { allow: { emails: [endUser] } } });
  const cfg = await call(client, 'configure_module', { app_id: created.app_id, module: 'files', config: { rules: { read: 'public' } } });
  check(cfg.applied === true, 'files module configured (read: public)', cfg);
  const sdk = { Origin: `https://${prodHost}`, 'X-Drobek-SDK': '1' };
  const sent = await appRequest(prodHost, '/__drobek/v1/auth/send-code', {
    method: 'POST',
    headers: { ...sdk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: endUser }),
  });
  check(sent.status === 200, 'end-user sign-in code sent', sent.body);
  const code = await pollCode(endUser);
  const verified = await appRequest(prodHost, '/__drobek/v1/auth/verify', {
    method: 'POST',
    headers: { ...sdk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: endUser, code }),
  });
  check(verified.status === 200, 'end user signed in on the app host', verified.body);
  const setCookie = [].concat(verified.headers['set-cookie'] ?? []).join('\n');
  const cookie = /(__Host-drobek_eu=[0-9a-f]{64})/.exec(setCookie)?.[1];
  check(Boolean(cookie), 'end-user session cookie', setCookie);

  const bytes = Buffer.concat([PNG_SIG, randomBytes(4096)]);
  const body = Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="rehearsal.png"\r\nContent-Type: image/png\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  const up = await appRequest(prodHost, '/__drobek/v1/files', {
    method: 'POST',
    headers: { ...sdk, Cookie: cookie, 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
    body,
  });
  check(up.status === 201, 'file uploaded (files module)', up.body);
  const file = JSON.parse(up.body);
  const got = await appRequest(prodHost, file.url);
  check(got.status === 200 && sha256(got.bytes) === sha256(bytes), `file downloads (${file.size} B, ${file.type})`);

  writeFileSync(
    STATE_FILE,
    JSON.stringify({ app_id: created.app_id, slug: created.slug, marker, prod_host: prodHost, file_url: file.url, file_sha256: sha256(bytes) }, null, 2)
  );
  await client.close();
}

async function verify() {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const client = await connect();
  const listed = await call(client, 'list_apps', {});
  const apps = (listed.workspaces ?? []).flatMap((w) => w.apps ?? []);
  const found = apps.some((a) => a.app_id === state.app_id || a.id === state.app_id || a.slug === state.slug);
  check(found || JSON.stringify(listed).includes(state.app_id), `the restored API key lists the app (${state.slug})`, listed);
  const prod = await appRequest(state.prod_host, '/');
  check(prod.status === 200 && prod.body.includes(state.marker), `the restored production host serves the marker (HTTP ${prod.status})`, prod.body.slice(0, 200));
  const got = await appRequest(state.prod_host, state.file_url);
  check(got.status === 200 && sha256(got.bytes) === state.file_sha256, 'the restored file downloads byte for byte', { status: got.status });
  if (!APPS_DOMAIN || !state.prod_host.endsWith(APPS_DOMAIN)) throw new Error('unexpected app host');
  await client.close();
}

try {
  if (phase === 'seed') await seed();
  else if (phase === 'verify') await verify();
  else throw new Error('usage: selfhost-rehearsal.mjs seed|verify');
  process.exit(0);
} catch (err) {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
