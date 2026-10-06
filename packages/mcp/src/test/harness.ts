/**
 * Unit-test harness: test deps (in-memory lease store on a controllable
 * clock, a recording change notifier, a real compiler, APPS_DOMAIN=drobek.app)
 * and an MCP client connected over an in-memory transport to a server with
 * the tools registered — the same wiring @drobek/oauth uses.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AssetDisk, memoryUploadTokenStore } from '@drobek/apps';
import { Compiler, type CompileLimits } from '@drobek/compile';
import type { DnsResolver } from '@drobek/domains';
import { noopLogger } from '@drobek/core';
import { loadModuleRuntime, memoryRateLimiter, type ModuleRuntime } from '@drobek/modules';
import type { AppChangedEvent, ToolDeps, ToolPrincipal } from '../context.js';
import { insightsLogStore } from '../context.js';
import { memoryLeaseStore } from '../lease.js';
import { registerAppTools } from '../register.js';
import { greet } from './modules.js';

let sharedRuntime: Promise<ModuleRuntime> | null = null;

/** A general skill `data` (so a firebase import can point at it). */
function testSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drobek-mcp-skills-'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(
    join(dir, 'data', 'SKILL.md'),
    '---\nname: data\ndescription: you need to store records on the server\n---\n# data\n\nStore records.\n'
  );
  return dir;
}

/**
 * The test module runtime: the `greet` module + one general skill (`data`), a
 * fixed dashboard origin (confirm_url), in-memory rate limiting.
 */
function testModules(): Promise<ModuleRuntime> {
  sharedRuntime ??= loadModuleRuntime({
    env: { APPS_DOMAIN: 'drobek.app', PUBLIC_APP_URL: 'https://dash.drobek.test', DROBEK_MIGRATE_ON_START: '0', DROBEK_MASTER_KEY: '22'.repeat(32) },
    log: noopLogger,
    modules: [greet],
    skillsDir: testSkillsDir(),
    deps: {
      rateLimit: memoryRateLimiter(),
      principal: async () => ({ kind: 'anon' }),
      email: { send: async () => {} },
    },
  });
  return sharedRuntime;
}

interface TestClock {
  now: () => number;
  advance: (ms: number) => void;
}

function testClock(start = Date.UTC(2026, 8, 23, 12, 0, 0)): TestClock {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** A mutable DNS zone for verify_domain (a missing name = NODATA, a name in `fail` = SERVFAIL). */
interface TestZone {
  txt: Record<string, string[]>;
  cname: Record<string, string[]>;
  fail: Set<string>;
}

function zoneResolver(zone: TestZone): DnsResolver {
  const read = async (map: Record<string, string[]>, name: string) => {
    if (zone.fail.has(name)) throw Object.assign(new Error('servfail'), { code: 'ESERVFAIL' });
    const v = map[name];
    if (!v) throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
    return v;
  };
  const nodata = () => Promise.reject(Object.assign(new Error('nodata'), { code: 'ENODATA' }));
  return {
    resolveTxt: async (name) => (await read(zone.txt, name)).map((v) => [v]),
    resolveCname: (name) => read(zone.cname, name),
    resolve4: nodata,
    resolve6: nodata,
  };
}

export interface TestDeps extends ToolDeps {
  events: AppChangedEvent[];
  clock: TestClock;
  /** The in-memory upload tokens and the upload-URL budget left (set it to test rate_limited). */
  uploadTokens: ReturnType<typeof memoryUploadTokenStore>;
  uploadBudget: { left: number };
  /** What verify_domain's lookups answer. */
  zone: TestZone;
  /** The end-user session epoch per app (sign_out_end_users raises it). */
  sessionEpochs: Map<string, number>;
  /** invite_member's invites by token, the e-mails it sent, and whether the next send fails. */
  invited: { tokens: Map<string, { workspaceId: string; role: string; email: string | null }>; sent: { email: string; workspaceName: string; role: string; acceptUrl: string }[]; failNext: boolean };
}

export function testDeps(limits: Partial<CompileLimits> = {}): TestDeps {
  const clock = testClock();
  const compiler = new Compiler(limits);
  const events: AppChangedEvent[] = [];
  const uploadTokens = memoryUploadTokenStore(clock.now);
  const uploadBudget = { left: 1000 };
  const zone: TestZone = { txt: {}, cname: {}, fail: new Set() };
  const sessionEpochs = new Map<string, number>();
  const invited: TestDeps['invited'] = { tokens: new Map(), sent: [], failNext: false };
  let inviteSeq = 0;
  return {
    leases: memoryLeaseStore(clock.now),
    notifyAppChanged: async (e) => {
      events.push(e);
    },
    compile: (files, opts) => compiler.compile(files, opts),
    limits: compiler.limits,
    now: clock.now,
    env: { APPS_DOMAIN: 'drobek.app' },
    log: noopLogger,
    modules: testModules,
    // Postgres (PGlite) only — no Redis for the daily serving counters.
    logs: insightsLogStore({ flushSignals: false }),
    assets: {
      tokens: uploadTokens,
      uploadAllowed: async () => uploadBudget.left-- > 0,
      disk: new AssetDisk(mkdtempSync(join(tmpdir(), 'drobek-mcp-assets-'))),
    },
    dns: () => zoneResolver(zone),
    revokeEndUserSessions: async (appId) => {
      const epoch = (sessionEpochs.get(appId) ?? 0) + 1;
      sessionEpochs.set(appId, epoch);
      return epoch;
    },
    invites: {
      create: async (a) => {
        const token = (++inviteSeq).toString(16).padStart(64, '0');
        invited.tokens.set(token, { workspaceId: a.workspaceId, role: a.role, email: a.email ?? null });
        return { token, id: token.slice(-16) };
      },
      withdraw: async (token) => {
        invited.tokens.delete(token);
      },
      send: async (m) => {
        if (invited.failNext) {
          invited.failNext = false;
          throw new Error('smtp down');
        }
        invited.sent.push(m);
      },
    },
    invited,
    events,
    clock,
    uploadTokens,
    uploadBudget,
    zone,
    sessionEpochs,
  };
}

/** The attributes of an envelope's opening marker. */
function envelopeAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/(\w+)=("(?:[^"\\]|\\.)*")/g)) attrs[m[1]] = JSON.parse(m[2]) as string;
  return attrs;
}

/**
 * read_file's answer: every `<untrusted-app-file>` block in order (one file →
 * that file's shape; several, or a trailing report → `{ version, files,
 * omitted?, missing?, note? }`).
 */
function decodeFiles(text: string): Record<string, unknown> {
  const files: Record<string, unknown>[] = [];
  let pos = 0;
  for (;;) {
    const open = /^<untrusted-app-file (.*)>$/m.exec(text.slice(pos));
    if (!open) break;
    const attrs = envelopeAttrs(open[1]);
    const start = pos + open.index + open[0].length + 1;
    const closing = `\n</untrusted-app-file nonce="${attrs.nonce}">`;
    const end = text.indexOf(closing, start - 1);
    const body = text.slice(start, end);
    pos = end + closing.length;
    const binary = /^\(binary file, (\d+) bytes — no text content\)$/.exec(body);
    const base = {
      path: attrs.path,
      version: Number(attrs.version),
      untrusted: true,
      ...(attrs.total_lines !== undefined ? { total_lines: Number(attrs.total_lines) } : {}),
      ...(attrs.lines !== undefined ? { lines: attrs.lines } : {}),
    };
    files.push(binary ? { ...base, binary: true, size: Number(binary[1]) } : { ...base, content: body });
  }
  const after = text.slice(pos).replace(/^\n+/, '');
  const report = after ? (JSON.parse(after) as Record<string, unknown>) : null;
  if (files.length === 1 && !report) return files[0];
  return { version: files[0]?.version, untrusted: true, files, ...report };
}

/**
 * The payload of an untrusted envelope (read_file, query_data, get_logs answer
 * no structuredContent): the attributes of the opening marker plus
 * the body, rebuilt into the tool's result shape so tests can assert on it.
 * null when `text` is not an envelope.
 */
function decodeUntrusted(text: string): Record<string, unknown> | null {
  const list = /^<untrusted-(form-submissions|end-users|uploads|activity|feedback) (.*)>$/m.exec(text);
  if (list) {
    const nonce = /nonce="([0-9a-f]+)"/.exec(list[2])?.[1];
    const start = list.index + list[0].length + 1;
    const closing = `\n</untrusted-${list[1]} nonce="${nonce}">`;
    const end = text.indexOf(closing, start - 1);
    const after = text.slice(end + closing.length).replace(/^\n+/, '');
    return { ...(JSON.parse(text.slice(start, end)) as Record<string, unknown>), ...(after ? { note: after } : {}) };
  }
  const open = /^<untrusted-app-(file|data|logs|search) (.*)>$/m.exec(text);
  if (!open) return null;
  if (open[1] === 'file') return decodeFiles(text);
  const attrs = envelopeAttrs(open[2]);
  const start = open.index + open[0].length + 1;
  const closing = `\n</untrusted-app-${open[1]} nonce="${attrs.nonce}">`;
  const end = text.indexOf(closing, start - 1);
  const body = text.slice(start, end);
  const after = text.slice(end + closing.length).replace(/^\n+/, '');
  if (open[1] === 'search') {
    return {
      app_id: attrs.app_id,
      version: Number(attrs.version),
      matches: JSON.parse(body) as unknown,
      total: Number(attrs.total),
      files_searched: Number(attrs.files_searched),
      untrusted: true,
      ...(after ? (JSON.parse(after) as Record<string, unknown>) : {}),
    };
  }
  if (open[1] === 'data') {
    return {
      app_id: attrs.app_id,
      collection: attrs.collection,
      records: JSON.parse(body) as unknown,
      total: Number(attrs.total),
      next_cursor: attrs.next_cursor || null,
      untrusted: true,
    };
  }
  const render = attrs.latest_version
    ? {
        version: Number(attrs.latest_version),
        beacon: attrs.beacon !== 'off',
        page_loads: Number(attrs.page_loads ?? 0),
        errors: Number(attrs.page_errors ?? 0),
      }
    : null;
  return {
    app_id: attrs.app_id,
    kind: attrs.kind,
    since: attrs.since,
    entries: JSON.parse(body) as unknown,
    untrusted: true,
    ...(render ? { render } : {}),
    ...(after ? { note: after } : {}),
  };
}

export interface ToolCall {
  isError: boolean;
  /** structuredContent — or, for the untrusted tools, the payload decoded from the envelope text. */
  body: Record<string, unknown>;
  /** The first text content block. */
  text: string;
}

export async function connect(principal: ToolPrincipal, deps: ToolDeps): Promise<{
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolCall>;
  client: Client;
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: 'drobek-test', version: '0' }, { capabilities: { tools: {} } });
  registerAppTools(server, principal, { deps });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'mcp-test', version: '0' });
  await client.connect(clientSide);
  return {
    client,
    close: () => client.close(),
    call: async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
      const body = (res.structuredContent as Record<string, unknown> | undefined) ?? decodeUntrusted(text) ?? { text };
      return { isError: Boolean(res.isError), body, text };
    },
  };
}
