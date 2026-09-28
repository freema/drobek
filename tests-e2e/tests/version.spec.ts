import { expect, test } from '@playwright/test';

test('api/version returns a non-empty sha @smoke', async ({ request }) => {
  const res = await request.get('/api/version');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.name).toBe('drobek');
  expect(typeof body.sha).toBe('string');
  expect(body.sha.length).toBeGreaterThan(0);
  // NSO-345: the same module list /healthz serves.
  expect(Array.isArray(body.modules)).toBe(true);
  // NSO-340: startedAt is the process start; commitTime is null in an image built without it.
  expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt);
  if (body.commitTime !== null) expect(new Date(body.commitTime).toISOString()).toBe(body.commitTime);
});
