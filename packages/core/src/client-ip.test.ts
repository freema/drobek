import { describe, expect, it, vi } from 'vitest';
import { perIpLimitKey } from './client-ip.js';

function spyLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('perIpLimitKey', () => {
  it('a resolved IP is the key (trimmed); nothing is logged', () => {
    const log = spyLogger();
    expect(perIpLimitKey('203.0.113.7', 'test-known', log)).toBe('203.0.113.7');
    expect(perIpLimitKey(' 2001:db8::1 ', 'test-known', log)).toBe('2001:db8::1');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('no IP → null (never a shared placeholder such as "unknown")', () => {
    const log = spyLogger();
    expect(perIpLimitKey(null, 'test-null', log)).toBeNull();
    expect(perIpLimitKey(undefined, 'test-null', log)).toBeNull();
    expect(perIpLimitKey('', 'test-null', log)).toBeNull();
    expect(perIpLimitKey('   ', 'test-null', log)).toBeNull();
  });

  it('warns once per bucket per process, naming the bucket', () => {
    const log = spyLogger();
    for (let i = 0; i < 5; i += 1) perIpLimitKey(null, 'test-once-a', log);
    perIpLimitKey(undefined, 'test-once-b', log);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[0][0]).toContain('"test-once-a"');
    expect(log.warn.mock.calls[0][0]).toContain('TRUST_PROXY');
    expect(log.warn.mock.calls[0][1]).toEqual({ event: 'rate_limit_no_client_ip', bucket: 'test-once-a' });
    expect(log.warn.mock.calls[1][1]).toEqual({ event: 'rate_limit_no_client_ip', bucket: 'test-once-b' });
  });
});
