/**
 * Unit-test harness: test deps (in-memory lease store on a controllable
 * clock, a recording change notifier, a real compiler, APPS_DOMAIN=drobek.app)
 * and an MCP client connected over an in-memory transport to a server with
 * the tools registered — the same wiring @drobek/oauth uses.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Compiler, type CompileLimits } from '@drobek/compile';
import { noopLogger } from '@drobek/core';
import type { AppChangedEvent, ToolDeps, ToolPrincipal } from '../context.js';
import { memoryLeaseStore } from '../lease.js';
import { registerAppTools } from '../register.js';

export interface TestClock {
  now: () => number;
  advance: (ms: number) => void;
}

export function testClock(start = Date.UTC(2026, 8, 23, 12, 0, 0)): TestClock {
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
    compile: (files) => compiler.compile(files),
    limits: compiler.limits,
    now: clock.now,
    env: { APPS_DOMAIN: 'drobek.app' },
    log: noopLogger,
    events,
    clock,
  };
}

export interface ToolCall {
  isError: boolean;
  /** structuredContent (every drobek tool returns it). */
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
      const body = (res.structuredContent as Record<string, unknown> | undefined) ?? { text };
      return { isError: Boolean(res.isError), body, text };
    },
  };
}
