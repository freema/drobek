import { describe, expect, it } from 'vitest';
import {
  ConcurrencyGate,
  DEFAULT_PROXY_MAX_CONCURRENT,
  DEFAULT_PROXY_MAX_CONCURRENT_PER_APP,
  acquireProxySlot,
} from './concurrency.server.js';
import { ProxyError, proxyErrorStatus } from './errors.js';

const env = (over: Record<string, string>) => over as NodeJS.ProcessEnv;

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ProxyError ? e.code : 'other';
  }
}

describe('ConcurrencyGate', () => {
  it('caps the calls in flight per key and in total; a release frees the slot (idempotent)', () => {
    const gate = new ConcurrencyGate();
    const a1 = gate.tryAcquire('a', 3, 2)!;
    const a2 = gate.tryAcquire('a', 3, 2)!;
    expect(gate.tryAcquire('a', 3, 2)).toBeNull(); // per key
    const b1 = gate.tryAcquire('b', 3, 2)!;
    expect(gate.tryAcquire('b', 3, 2)).toBeNull(); // total
    expect(gate.inFlight()).toBe(3);
    a1();
    a1();
    expect(gate.inFlight()).toBe(2);
    expect(gate.inFlight('a')).toBe(1);
    const b2 = gate.tryAcquire('b', 3, 2)!;
    expect(b2).toBeTypeOf('function');
    for (const r of [a2, b1, b2]) r();
    expect(gate.inFlight()).toBe(0);
    expect(gate.inFlight('a')).toBe(0);
  });
});

describe('acquireProxySlot', () => {
  it('defaults: 32 in flight for the process, 8 per app', () => {
    expect([DEFAULT_PROXY_MAX_CONCURRENT, DEFAULT_PROXY_MAX_CONCURRENT_PER_APP]).toEqual([32, 8]);
    const gate = new ConcurrencyGate();
    const held = Array.from({ length: 8 }, () => acquireProxySlot('app_a', env({}), gate));
    expect(codeOf(() => acquireProxySlot('app_a', env({}), gate))).toBe('proxy_busy');
    held.forEach((r) => r());
  });

  it('PROXY_MAX_CONCURRENT_PER_APP: one app at its cap → proxy_busy (429); another app still gets a slot', () => {
    const gate = new ConcurrencyGate();
    const e = env({ PROXY_MAX_CONCURRENT_PER_APP: '2', PROXY_MAX_CONCURRENT: '10' });
    const r1 = acquireProxySlot('app_a', e, gate);
    acquireProxySlot('app_a', e, gate);
    let err: unknown;
    try {
      acquireProxySlot('app_a', e, gate);
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(ProxyError);
    expect((err as ProxyError).code).toBe('proxy_busy');
    expect(proxyErrorStatus('proxy_busy')).toBe(429);
    expect((err as Error).message).toMatch(/this app in flight \(at most 2\)/);
    expect(codeOf(() => acquireProxySlot('app_b', e, gate))).toBeNull();
    r1();
    expect(codeOf(() => acquireProxySlot('app_a', e, gate))).toBeNull();
  });

  it('PROXY_MAX_CONCURRENT: the process cap applies across apps', () => {
    const gate = new ConcurrencyGate();
    const e = env({ PROXY_MAX_CONCURRENT: '3', PROXY_MAX_CONCURRENT_PER_APP: '5' });
    for (const app of ['a', 'b', 'c']) acquireProxySlot(app, e, gate);
    let err: unknown;
    try {
      acquireProxySlot('d', e, gate);
    } catch (x) {
      err = x;
    }
    expect((err as ProxyError).code).toBe('proxy_busy');
    expect((err as Error).message).toMatch(/The proxy is busy/);
  });

  it('an invalid env value falls back to the default', () => {
    const gate = new ConcurrencyGate();
    const e = env({ PROXY_MAX_CONCURRENT_PER_APP: 'lots', PROXY_MAX_CONCURRENT: '-1' });
    const held = Array.from({ length: DEFAULT_PROXY_MAX_CONCURRENT_PER_APP }, () => acquireProxySlot('app', e, gate));
    expect(codeOf(() => acquireProxySlot('app', e, gate))).toBe('proxy_busy');
    held.forEach((r) => r());
  });
});
