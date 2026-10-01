import { describe, expect, it, vi } from 'vitest';
import { filesReadiness } from './readiness.js';

const files = new Map([
  ['index.html', '<html><head><title>App</title><meta name="description" content="An app."><link rel="icon" href="/favicon.svg"></head></html>'],
]);

describe('filesReadiness: the module rules audit sees the live configs and the pending changes', () => {
  it("passes each module's config, enabled flag and pending_confirmation to the checks", async () => {
    const appModules = vi.fn(async () => ({
      auth: { enabled: true, configured: false, config: {}, pending: false },
      data: {
        enabled: true,
        configured: true,
        config: { collections: { wall: { rules: { read: 'public', create: 'public' } } } },
        pending: true,
        pending_confirmation: ['data.collections.wall.rules.update: "owner|admin" → "public" (anyone, signed in or not, may change every record)'],
      },
    }));
    const warn = vi.fn();
    const report = await filesReadiness(
      { deps: { env: {}, log: { warn } as never }, modules: { appModules } as never },
      'app-1',
      new Set(['auth', 'data']),
      files,
      []
    );
    expect(appModules).toHaveBeenCalledWith('app-1', undefined, new Set(['auth', 'data']));
    expect(report.ready).toBe(true);
    expect(report.warnings.map((w) => w.code)).toEqual(['data_public_write_no_schema', 'module_change_pending']);
    expect(report.warnings[1].message).toContain('data.collections.wall.rules.update');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failed config load leaves the audit out and never fails the write', async () => {
    const warn = vi.fn();
    const failing = {
      appModules: async () => {
        throw new Error('db down');
      },
    };
    const report = await filesReadiness({ deps: { env: {}, log: { warn } as never }, modules: failing as never }, 'app-1', new Set(), files, []);
    expect(report).toEqual({ ready: true, blocking: [], warnings: [] });
    expect(warn).toHaveBeenCalledWith('readiness check failed', expect.objectContaining({ app_id: 'app-1', check: 'modules' }));
  });
});
