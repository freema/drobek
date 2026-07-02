import { expect, test } from '@playwright/test';

test('healthz reports db and redis up @smoke', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, db: 'up', redis: 'up' });
});
