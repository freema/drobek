import { expect, test } from '@playwright/test';

test('healthz reports db and redis up @smoke', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, db: 'up', redis: 'up' });
  // The active modules — name, version, source, contract (and operatorOnly: true
  // on a module without a skill); never a path.
  expect(Array.isArray(body.modules)).toBe(true);
  for (const { operatorOnly, ...m } of body.modules as Record<string, unknown>[]) {
    expect(Object.keys(m).sort()).toEqual(['contract', 'name', 'source', 'version']);
    expect(['builtin', 'dir']).toContain(m.source);
    if (operatorOnly !== undefined) expect(operatorOnly).toBe(true);
  }
  expect(JSON.stringify(body.modules)).not.toMatch(/\/(data|app|repo)\//);
});
