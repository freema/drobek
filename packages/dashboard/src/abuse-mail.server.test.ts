/**
 * A new abuse report e-mails every super-admin AND OPERATOR_EMAIL,
 * each address once (case-insensitive); nobody configured → no mail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => ({ send: vi.fn(async (_m: { to: string; subject: string; text: string; html: string }) => 'sent' as const) }));
const redis = vi.hoisted(() => ({ set: vi.fn(async () => 'OK' as string | null) }));

vi.mock('@drobek/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drobek/email')>()),
  sendEmail: mail.send,
}));
vi.mock('@drobek/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drobek/core')>()),
  getRedis: () => ({ set: redis.set }),
}));

const { mailSuperAdminsAboutReport } = await import('./abuse-mail.server.js');

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let k = 0;
const report = () => ({ reportId: `r${++k}`, host: `h${k}.drobek.app`, reason: 'phishing', details: 'x', reporterEmail: null, app: null });

beforeEach(() => {
  mail.send.mockClear();
  redis.set.mockClear();
});

describe('abuse report recipients', () => {
  it('every super-admin plus OPERATOR_EMAIL, deduplicated case-insensitively', async () => {
    const env = { SUPERADMIN_EMAIL: 'Boss@X.test, two@x.test', OPERATOR_EMAIL: ' ops@x.test ', PUBLIC_APP_URL: 'https://dash.x.test' };
    expect(await mailSuperAdminsAboutReport(report(), log, env)).toEqual({ sent: 3, deduped: false });
    expect(mail.send.mock.calls.map((c) => c[0].to)).toEqual(['boss@x.test', 'two@x.test', 'ops@x.test']);

    mail.send.mockClear();
    await mailSuperAdminsAboutReport(report(), log, { ...env, OPERATOR_EMAIL: 'BOSS@x.test' });
    expect(mail.send.mock.calls.map((c) => c[0].to)).toEqual(['boss@x.test', 'two@x.test']);
  });

  it('OPERATOR_EMAIL alone is enough; nobody configured sends nothing', async () => {
    expect(await mailSuperAdminsAboutReport(report(), log, { OPERATOR_EMAIL: 'ops@x.test', PUBLIC_APP_URL: 'https://dash.x.test' })).toEqual({
      sent: 1,
      deduped: false,
    });
    mail.send.mockClear();
    expect(await mailSuperAdminsAboutReport(report(), log, {})).toEqual({ sent: 0, deduped: false });
    expect(mail.send).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('the queue link is a button on the server origin, the text part keeps the URL, the footer names the server', async () => {
    await mailSuperAdminsAboutReport(report(), log, { OPERATOR_EMAIL: 'ops@x.test', PUBLIC_APP_URL: 'https://dash.x.test' });
    const [m] = mail.send.mock.calls[0];
    expect(m.html).toMatch(/<a href="https:\/\/dash\.x\.test\/[^"]+"/);
    expect(m.text).toMatch(/Review the report queue: https:\/\/dash\.x\.test\//);
    expect(m.html).toContain('Sent by the drobek server at dash.x.test because you moderate this server');
  });
});
