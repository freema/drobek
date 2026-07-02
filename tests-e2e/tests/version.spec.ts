import { expect, test } from '@playwright/test';

test('api/version returns a non-empty sha @smoke', async ({ request }) => {
  const res = await request.get('/api/version');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(typeof body.sha).toBe('string');
  expect(body.sha.length).toBeGreaterThan(0);
});
