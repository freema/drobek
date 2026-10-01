import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';
import { OPS_JOB, OPS_MODULE, REPORT_FIELDS, drobekEnv, failNextJobRun, opsReports, type OpsReport } from './helpers/ops-probe';

/**
 * Server errors reach the operator's error reporter (ERROR_REPORTER): both
 * e2e stacks select the `capture` reporter of the operator-only fixture
 * `opsprobe`, which hands every report to proxy-echo. A failing module job
 * — the fixture's server job, armed to throw — arrives as one event: level
 * `error`, `module job failed`, the context naming the module and the job
 * and nothing else, the release, environment, time and fingerprint. The
 * thrown text is redacted before it leaves the server: the e-mail address
 * reads `[email]`, a `token=` value and a long opaque run `[redacted]`.
 */

function letters(n: number): string {
  return Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join('');
}

test('a failing module job reaches the error reporter: its context only, the address and secrets redacted @local', async () => {
  skipUnlessLocal();
  test.skip(drobekEnv('ERROR_REPORTER') !== 'capture', 'this stack does not report through the ops-probe fixture (ERROR_REPORTER=capture)');
  test.setTimeout(90_000);
  const marker = `nightly${letters(12)}`;
  const address = `${letters(8)}.owner@example.org`;
  const secret = `s3cr3t${letters(10)}`;
  const opaque = randomBytes(24).toString('hex');
  await failNextJobRun(`import ${marker} failed for ${address}: token=${secret} after ${opaque}`);

  let report: OpsReport | undefined;
  await expect
    .poll(
      () => {
        report = opsReports().find((r) => r.event.error?.message.includes(marker));
        return report !== undefined;
      },
      { timeout: 45_000, intervals: [1_000] }
    )
    .toBe(true);
  const event = report!.event;

  expect(Object.keys(event).every((k) => REPORT_FIELDS.includes(k)), JSON.stringify(Object.keys(event))).toBe(true);
  expect(event).toMatchObject({ level: 'error', message: 'module job failed' });
  expect(event.context).toEqual({ kind: 'module_job', module: OPS_MODULE, job: OPS_JOB });
  expect(event.error).toMatchObject({ name: 'Error', message: `import ${marker} failed for [email]: token=[redacted] after [redacted]` });
  expect(String(event.release)).not.toBe('');
  expect(['development', 'production']).toContain(event.environment);
  expect(Math.abs(Date.now() - Date.parse(String(event.timestamp)))).toBeLessThan(5 * 60_000);
  expect(String(event.fingerprint)).toMatch(/^[0-9a-f]{32}$/);

  const sent = JSON.stringify(event);
  expect(sent).toContain(marker);
  for (const leaked of [address, secret, opaque]) expect(sent).not.toContain(leaked);
});
