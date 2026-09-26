import { expect, test } from '@playwright/test';

test('healthz reports db and redis up @smoke', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, db: 'up', redis: 'up' });
  // NSO-345: the active modules — name, version, source, contract; never a path.
  expect(Array.isArray(body.modules)).toBe(true);
  for (const m of body.modules as Record<string, unknown>[]) {
    expect(Object.keys(m).sort()).toEqual(['contract', 'name', 'source', 'version']);
    expect(['builtin', 'dir']).toContain(m.source);
  }
  expect(JSON.stringify(body.modules)).not.toMatch(/\/(data|app|repo)\//);
});
