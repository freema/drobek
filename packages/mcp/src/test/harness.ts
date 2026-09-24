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
import { Compiler, type CompileLimits } from '@drobek/compile';
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

export interface TestDeps extends ToolDeps {
  events: AppChangedEvent[];
  clock: TestClock;
}

export function testDeps(limits: Partial<CompileLimits> = {}): TestDeps {
  const clock = testClock();
  const compiler = new Compiler(limits);
  const events: AppChangedEvent[] = [];
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
    events,
    clock,
  };
}

/**
 * The payload of an untrusted envelope (read_file, query_data, get_logs answer
 * no structuredContent — NSO-324): the attributes of the opening marker plus
 * the body, rebuilt into the tool's result shape so tests can assert on it.
 * null when `text` is not an envelope.
 */
function decodeUntrusted(text: string): Record<string, unknown> | null {
  const open = /^<untrusted-app-(file|data|logs) (.*)>$/m.exec(text);
  if (!open) return null;
  const attrs: Record<string, string> = {};
  for (const m of open[2].matchAll(/(\w+)=("(?:[^"\\]|\\.)*")/g)) attrs[m[1]] = JSON.parse(m[2]) as string;
  const start = open.index + open[0].length + 1;
  const closing = `\n</untrusted-app-${open[1]} nonce="${attrs.nonce}">`;
  const end = text.indexOf(closing, start - 1);
  const body = text.slice(start, end);
  const after = text.slice(end + closing.length).replace(/^\n+/, '');
  if (open[1] === 'file') {
    const binary = /^\(binary file, (\d+) bytes — no text content\)$/.exec(body);
    const base = { path: attrs.path, version: Number(attrs.version), untrusted: true };
    return binary ? { ...base, binary: true, size: Number(binary[1]) } : { ...base, content: body };
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
  return { app_id: attrs.app_id, kind: attrs.kind, since: attrs.since, entries: JSON.parse(body) as unknown, untrusted: true, ...(after ? { note: after } : {}) };
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
