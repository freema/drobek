import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { TEST_ENV } from '../playwright.config';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function compose(cmd: string): void {
  execSync(`docker compose ${cmd}`, { cwd: repoRoot, stdio: 'inherit' });
}

// Needs to drive the LOCAL docker compose stack — never run against beta/prod.
test('healthz flips to 503 when redis is down and recovers @local', async ({
  request,
}) => {
  test.skip(TEST_ENV !== 'local', 'requires TEST_ENV=local (docker compose stack)');
  test.setTimeout(180_000);

  try {
    compose('stop redis');

    await expect
      .poll(
        async () => {
          const res = await request.get('/healthz');
          const body = await res.json();
          return { status: res.status(), ok: body.ok, redis: body.redis };
        },
        { timeout: 60_000, intervals: [1_000] }
      )
      .toEqual({ status: 503, ok: false, redis: 'down' });
  } finally {
    compose('start redis');
  }

  await expect
    .poll(
      async () => {
        const res = await request.get('/healthz');
        const body = await res.json();
        return { status: res.status(), ok: body.ok, redis: body.redis };
      },
      { timeout: 60_000, intervals: [1_000] }
    )
    .toEqual({ status: 200, ok: true, redis: 'up' });
});
