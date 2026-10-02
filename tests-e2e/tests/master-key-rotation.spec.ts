import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { hostRequest, previewHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { drobekEnv } from './helpers/ops-probe';
import { seedApp, seedVersion, withDb } from './helpers/seed';

/**
 * Rotating DROBEK_MASTER_KEY over the stored secrets, against the running
 * stack: a module secret of the hello module stored under an older key (the
 * server's DROBEK_MASTER_KEY_PREVIOUS is unset) cannot be read — the module
 * route fails closed; the rekey step (`task selfhost:rekey` =
 * `node dist/server/rekey.js`, run in the drobek container with that older
 * key as DROBEK_MASTER_KEY_PREVIOUS) re-wraps it under the current key, so
 * the server signs with it again; a second run re-wraps nothing;
 * `--forget-unknown` deletes a secret no key opens. The output carries counts
 * and names, never a key or the value.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 32 key bytes of a DROBEK_MASTER_KEY value: 64 hex chars, else the sha256 of a passphrase. */
function keyBytes(value: string): Buffer {
  return /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : createHash('sha256').update(value, 'utf8').digest();
}

const kekId = (value: string): string => createHash('sha256').update(keyBytes(value)).digest('hex').slice(0, 16);

/** An envelope exactly as @drobek/proxy writes one: AES-256-GCM under a fresh DEK, the DEK wrapped by the master key. */
function envelope(plaintext: string, master: string) {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const wrapIv = randomBytes(12);
  const w = createCipheriv('aes-256-gcm', keyBytes(master), wrapIv);
  const wrapped = Buffer.concat([w.update(dek), w.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: c.getAuthTag().toString('base64'),
    wrappedDek: [wrapIv, w.getAuthTag(), wrapped].map((b) => b.toString('base64')).join('.'),
    kekId: kekId(master),
  };
}

/** The rekey step inside the drobek container (dev: the TypeScript source; image: dist/server/rekey.js). */
function rekey(previous: string, ...args: string[]): { status: number | null; output: string } {
  const argv = args.join(' ');
  const cmd = `cd apps/server 2>/dev/null; if [ -f server/rekey.ts ]; then exec node_modules/.bin/tsx server/rekey.ts ${argv}; else exec node dist/server/rekey.js ${argv}; fi`;
  const r = spawnSync('docker', ['compose', 'exec', '-T', '-e', `DROBEK_MASTER_KEY_PREVIOUS=${previous}`, 'drobek', 'sh', '-c', cmd], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function seedWorkspace(): Promise<{ id: string; slug: string }> {
  const id = `ws_${randomBytes(12).toString('hex')}`;
  const slug = `e2e-rekey-${randomBytes(4).toString('hex')}`;
  await withDb((c) => c.query(`INSERT INTO workspaces (id, kind, slug, name) VALUES ($1, 'team', $2, 'Rekey e2e')`, [id, slug]));
  return { id, slug };
}

async function storeModuleSecret(appId: string, name: string, plaintext: string, master: string): Promise<void> {
  const e = envelope(plaintext, master);
  await withDb((c) =>
    c.query(
      `INSERT INTO module_secrets (app_id, module, name, ciphertext, iv, auth_tag, wrapped_dek, kek_id)
       VALUES ($1, 'hello', $2, $3, $4, $5, $6, $7)`,
      [appId, name, e.ciphertext, e.iv, e.authTag, e.wrappedDek, e.kekId]
    )
  );
}

async function secretRows(appId: string): Promise<Array<{ name: string; kek_id: string; ciphertext: string; wrapped_dek: string }>> {
  return withDb(async (c) => {
    const r = await c.query(`SELECT name, kek_id, ciphertext, wrapped_dek FROM module_secrets WHERE app_id = $1 ORDER BY name`, [appId]);
    return r.rows as Array<{ name: string; kek_id: string; ciphertext: string; wrapped_dek: string }>;
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('DROBEK_MASTER_KEY rotation — rekey @local', () => {
  test('a secret of the previous key moves to the current key; the module reads it again; a second run changes nothing', async () => {
    skipUnlessLocal();
    test.setTimeout(240_000);
    const current = drobekEnv('DROBEK_MASTER_KEY');
    const previous = randomBytes(32).toString('hex');
    const SECRET = `rotated-signature-${randomBytes(8).toString('hex')}`;
    const ws = await seedWorkspace();
    const app = await seedApp({ workspaceId: ws.id });
    await seedVersion({ appId: app.id });
    await storeModuleSecret(app.id, 'HELLO_SIGNATURE', SECRET, previous);
    const host = previewHost(app.slug);

    try {
      // The server has no DROBEK_MASTER_KEY_PREVIOUS: the module cannot open the secret and fails closed.
      const before = await hostRequest(host, '/__drobek/v1/hello');
      expect(before.status).toBe(500);
      expect(before.body).not.toContain(SECRET);

      const [stored] = await secretRows(app.id);
      const first = rekey(previous);
      expect([0, 1], first.output).toContain(first.status);
      expect(first.output).toMatch(/^module_secrets: 1 re-wrapped, \d+ already under DROBEK_MASTER_KEY, \d+ under an unknown key/m);
      for (const s of [previous, current, SECRET]) expect(first.output).not.toContain(s);

      // Only the wrap changed, now under the server's own key.
      const [moved] = await secretRows(app.id);
      expect(moved.kek_id).toBe(kekId(current));
      expect(moved.ciphertext).toBe(stored.ciphertext);
      expect(moved.wrapped_dek).not.toBe(stored.wrapped_dek);

      // The running server reads it with DROBEK_MASTER_KEY alone: the ping is signed with the value.
      const after = await hostRequest(host, '/__drobek/v1/hello');
      expect(after.status).toBe(200);
      const body = JSON.parse(after.body) as { message: string; signed: boolean; signature?: string };
      expect(body.signed).toBe(true);
      expect(body.signature).toBe(createHmac('sha256', SECRET).update(body.message).digest('hex').slice(0, 16));
      expect(after.body).not.toContain(SECRET);

      const second = rekey(previous);
      expect(second.output).toMatch(/^module_secrets: 0 re-wrapped/m);
      expect((await secretRows(app.id))[0].wrapped_dek).toBe(moved.wrapped_dek);
    } finally {
      await withDb((c) => c.query(`DELETE FROM module_secrets WHERE app_id = $1`, [app.id]));
    }
  });

  test('a secret under a key the server does not have: rekey names it and exits 1; --forget-unknown deletes it', async () => {
    skipUnlessLocal();
    test.setTimeout(240_000);
    const lost = randomBytes(32).toString('hex');
    const SECRET = `lost-signature-${randomBytes(8).toString('hex')}`;
    const ws = await seedWorkspace();
    const app = await seedApp({ workspaceId: ws.id });
    await storeModuleSecret(app.id, 'HELLO_SIGNATURE', SECRET, lost);
    const label = `${ws.slug}/${app.slug} hello.HELLO_SIGNATURE`;

    try {
      const unrelated = randomBytes(32).toString('hex');
      const kept = rekey(unrelated);
      expect(kept.status).toBe(1);
      expect(kept.output).toContain(`  - ${label}`);
      expect(kept.output).toContain('task selfhost:rekey FORGET_UNKNOWN=1');
      expect(await secretRows(app.id)).toHaveLength(1);

      const forgot = rekey(unrelated, '--forget-unknown');
      expect(forgot.output).toContain(`  - ${label}`);
      expect(forgot.output).toMatch(/^module_secrets: .* under an unknown key \(\d+ deleted\)/m);
      for (const s of [lost, unrelated, SECRET]) expect(forgot.output).not.toContain(s);
      expect(await secretRows(app.id)).toEqual([]);
    } finally {
      await withDb((c) => c.query(`DELETE FROM module_secrets WHERE app_id = $1`, [app.id]));
    }
  });
});
