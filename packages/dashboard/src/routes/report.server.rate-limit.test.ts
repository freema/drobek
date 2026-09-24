/**
 * The abuse report form's per-IP limit (NSO-328): a resolved client IP has its
 * own `abuse-report-ip` bucket; a request without one is not counted in a
 * shared `unknown` bucket — it is stored and the (per-app, hourly-capped)
 * super-admin mail path still runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rateLimitRedis = vi.fn(async (_bucket: string, _key: string, _limit: number, _windowMs: number) => ({ ok: true }));
vi.mock('@drobek/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/auth')>();
  return { ...actual, rateLimitRedis: (...a: Parameters<typeof rateLimitRedis>) => rateLimitRedis(...a) };
});

const createAbuseReport = vi.fn(async (input: { host: string; reason: string; clientIp?: string | null }) => ({
  id: 'rep_1',
  host: input.host,
  reason: input.reason,
  app: null,
}));
vi.mock('@drobek/apps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/apps')>();
  return { ...actual, createAbuseReport: (input: Parameters<typeof createAbuseReport>[0]) => createAbuseReport(input) };
});

const mailSuperAdminsAboutReport = vi.fn(async () => {});
vi.mock('../abuse-mail.server.js', () => ({ mailSuperAdminsAboutReport: () => mailSuperAdminsAboutReport() }));

import { action, REPORT_RATE_BUCKET } from './report.server.js';

function post(headers: Record<string, string> = {}): Promise<unknown> {
  const body = new URLSearchParams({ host: 'shop.example.com', reason: 'spam', details: 'probe', email: '', website: '' });
  const request = new Request('http://localhost/report', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
  return action({ request, params: {}, context: {} } as unknown as Parameters<typeof action>[0]);
}

/** React Router's `data()` wraps the result; read its status and payload. */
function unwrap(r: unknown): { status: number; data: unknown } {
  const d = r as { init?: { status?: number } | null; data: unknown };
  return { status: d.init?.status ?? 200, data: d.data };
}

beforeEach(() => {
  rateLimitRedis.mockClear();
  rateLimitRedis.mockImplementation(async () => ({ ok: true }));
  createAbuseReport.mockClear();
  mailSuperAdminsAboutReport.mockClear();
});

describe('POST /report per-IP limit', () => {
  it('a resolved client IP is counted in its own bucket; over the limit → 429, nothing stored', async () => {
    expect(unwrap(await post({ 'x-real-ip': '203.0.113.5' })).data).toEqual({ ok: true });
    expect(rateLimitRedis).toHaveBeenCalledWith(REPORT_RATE_BUCKET, '203.0.113.5', 5, 3_600_000);
    rateLimitRedis.mockImplementation(async () => ({ ok: false }));
    createAbuseReport.mockClear();
    expect(unwrap(await post({ 'x-real-ip': '203.0.113.5' })).status).toBe(429);
    expect(createAbuseReport).not.toHaveBeenCalled();
  });

  it('no client IP: the bucket is not consulted (no shared "unknown" key), the report is stored and mailed', async () => {
    const r = unwrap(await post());
    expect(r).toEqual({ status: 200, data: { ok: true } });
    expect(rateLimitRedis).not.toHaveBeenCalled();
    expect(createAbuseReport).toHaveBeenCalledTimes(1);
    expect(mailSuperAdminsAboutReport).toHaveBeenCalledTimes(1);
  });
});
