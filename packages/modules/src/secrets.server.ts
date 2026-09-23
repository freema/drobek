/**
 * Module secrets of an app (M1-01) — the minimal storage `ctx.secrets.get`
 * needs, built like the upstream secrets (§6): AES-256-GCM envelope (a random
 * DEK per value, wrapped by the KEK from DROBEK_MASTER_KEY, `kek_id` for
 * rotation; @drobek/proxy crypto). The plaintext exists only in memory, inside
 * a module handler.
 *
 * WHO WRITES: only the dashboard (the secrets form of M2-02 calls
 * `setModuleSecret`); there is NO MCP path to set or read a value, and no API
 * ever returns one — agents and get_app see `hasSecret` only.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, moduleSecrets } from '@drobek/db';
import { decryptSecret, encryptSecret } from '@drobek/proxy';

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const SECRET_MAX_BYTES = 8 * 1024;

export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

/** Store (or rotate) one secret value. Dashboard-only; validates name + size. */
export async function setModuleSecret(input: {
  appId: string;
  module: string;
  name: string;
  value: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!SECRET_NAME_RE.test(input.name)) throw new SecretStoreError('invalid secret name');
  if (typeof input.value !== 'string' || input.value.length === 0) throw new SecretStoreError('empty secret value');
  if (Buffer.byteLength(input.value) > SECRET_MAX_BYTES) throw new SecretStoreError('secret value too large');
  const envelope = encryptSecret(input.value, input.env);
  const row = {
    appId: input.appId,
    module: input.module,
    name: input.name,
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    authTag: envelope.authTag,
    wrappedDek: envelope.wrappedDek,
    kekId: envelope.kekId,
  };
  await getDb()
    .insert(moduleSecrets)
    .values(row)
    .onConflictDoUpdate({
      target: [moduleSecrets.appId, moduleSecrets.module, moduleSecrets.name],
      set: { ...row, updatedAt: new Date() },
    });
}

export async function deleteModuleSecret(appId: string, module: string, name: string): Promise<boolean> {
  const rows = await getDb()
    .delete(moduleSecrets)
    .where(and(eq(moduleSecrets.appId, appId), eq(moduleSecrets.module, module), eq(moduleSecrets.name, name)))
    .returning({ name: moduleSecrets.name });
  return rows.length > 0;
}

/** The plaintext (in memory only), or null when unset. Throws on a wrong/rotated KEK (fail closed). */
export async function getModuleSecret(
  appId: string,
  module: string,
  name: string,
  env?: NodeJS.ProcessEnv
): Promise<string | null> {
  const [row] = await getDb()
    .select()
    .from(moduleSecrets)
    .where(and(eq(moduleSecrets.appId, appId), eq(moduleSecrets.module, module), eq(moduleSecrets.name, name)))
    .limit(1);
  if (!row) return null;
  return decryptSecret(
    { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag, wrappedDek: row.wrappedDek, kekId: row.kekId },
    env
  );
}

/** Which of `names` are set for this app + module — names only, never values. */
export async function secretsSet(appId: string, module: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const rows = await getDb()
    .select({ name: moduleSecrets.name })
    .from(moduleSecrets)
    .where(and(eq(moduleSecrets.appId, appId), eq(moduleSecrets.module, module), inArray(moduleSecrets.name, names)));
  return new Set(rows.map((r) => r.name));
}
