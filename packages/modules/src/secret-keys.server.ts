/**
 * The master key of the stored secrets: the envelopes in `upstream_secrets`
 * (proxy upstreams) and `module_secrets` (module secrets of an app), each a
 * DEK wrapped by the KEK from DROBEK_MASTER_KEY (@drobek/proxy crypto).
 *
 * Rotating DROBEK_MASTER_KEY: the key used before goes into
 * DROBEK_MASTER_KEY_PREVIOUS (still decrypts, never encrypts), `rekeySecrets`
 * (`task selfhost:rekey`) re-wraps every envelope of it under the current key,
 * then DROBEK_MASTER_KEY_PREVIOUS is removed. The start refuses a database
 * that still holds envelopes of a key the server does not have, instead of
 * failing on every secret later.
 *
 * Only `kek_id` and the wrapped DEK are read: re-wrapping never decrypts a
 * secret value, and nothing here returns or logs a key, a DEK or a value —
 * counts and the names of the affected upstreams / module secrets only.
 */
import { and, count, eq, ne } from 'drizzle-orm';
import { apps, getDb, moduleSecrets, upstreamSecrets, upstreams, workspaces, type DB } from '@drobek/db';
import { keyOf, keyRingFromEnv, previousKekFromEnv, rewrapSecret, type KeyRing } from '@drobek/proxy';

type SecretTable = 'upstream_secrets' | 'module_secrets';

/** One stored envelope's key part: enough to re-wrap or delete exactly this row. */
interface StoredWrap {
  /** `<workspace>/<upstream>` or `<workspace>/<app> <module>.<NAME>` — names only. */
  label: string;
  wrappedDek: string;
  kekId: string;
  replace(db: DB, next: { wrappedDek: string; kekId: string }): Promise<boolean>;
  remove(db: DB): Promise<boolean>;
}

interface EnvelopeStore {
  table: SecretTable;
  kekIds(db: DB): Promise<Array<{ kekId: string; n: number }>>;
  /** Every envelope NOT wrapped by `kekId`. */
  notUnder(db: DB, kekId: string): Promise<StoredWrap[]>;
}

const upstreamStore: EnvelopeStore = {
  table: 'upstream_secrets',
  kekIds: (db) => db.select({ kekId: upstreamSecrets.kekId, n: count() }).from(upstreamSecrets).groupBy(upstreamSecrets.kekId),
  async notUnder(db, kekId) {
    const rows = await db
      .select({ id: upstreamSecrets.upstreamId, wrappedDek: upstreamSecrets.wrappedDek, kekId: upstreamSecrets.kekId, name: upstreams.name, workspace: workspaces.slug })
      .from(upstreamSecrets)
      .innerJoin(upstreams, eq(upstreams.id, upstreamSecrets.upstreamId))
      .innerJoin(workspaces, eq(workspaces.id, upstreams.workspaceId))
      .where(ne(upstreamSecrets.kekId, kekId));
    return rows.map((r) => {
      const same = and(eq(upstreamSecrets.upstreamId, r.id), eq(upstreamSecrets.kekId, r.kekId), eq(upstreamSecrets.wrappedDek, r.wrappedDek));
      return {
        label: `${r.workspace}/${r.name}`,
        wrappedDek: r.wrappedDek,
        kekId: r.kekId,
        replace: async (d, next) => (await d.update(upstreamSecrets).set(next).where(same).returning({ id: upstreamSecrets.upstreamId })).length > 0,
        remove: async (d) => (await d.delete(upstreamSecrets).where(same).returning({ id: upstreamSecrets.upstreamId })).length > 0,
      };
    });
  },
};

const moduleStore: EnvelopeStore = {
  table: 'module_secrets',
  kekIds: (db) => db.select({ kekId: moduleSecrets.kekId, n: count() }).from(moduleSecrets).groupBy(moduleSecrets.kekId),
  async notUnder(db, kekId) {
    const rows = await db
      .select({
        appId: moduleSecrets.appId,
        module: moduleSecrets.module,
        name: moduleSecrets.name,
        wrappedDek: moduleSecrets.wrappedDek,
        kekId: moduleSecrets.kekId,
        app: apps.slug,
        workspace: workspaces.slug,
      })
      .from(moduleSecrets)
      .innerJoin(apps, eq(apps.id, moduleSecrets.appId))
      .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
      .where(ne(moduleSecrets.kekId, kekId));
    return rows.map((r) => {
      const same = and(
        eq(moduleSecrets.appId, r.appId),
        eq(moduleSecrets.module, r.module),
        eq(moduleSecrets.name, r.name),
        eq(moduleSecrets.kekId, r.kekId),
        eq(moduleSecrets.wrappedDek, r.wrappedDek)
      );
      return {
        label: `${r.workspace}/${r.app} ${r.module}.${r.name}`,
        wrappedDek: r.wrappedDek,
        kekId: r.kekId,
        replace: async (d, next) => (await d.update(moduleSecrets).set(next).where(same).returning({ name: moduleSecrets.name })).length > 0,
        remove: async (d) => (await d.delete(moduleSecrets).where(same).returning({ name: moduleSecrets.name })).length > 0,
      };
    });
  },
};

const STORES: readonly EnvelopeStore[] = [upstreamStore, moduleStore];

/** Per table: envelopes wrapped by DROBEK_MASTER_KEY, by DROBEK_MASTER_KEY_PREVIOUS, and by neither. */
export interface SecretKeyCounts {
  table: SecretTable;
  current: number;
  previous: number;
  unknown: number;
}

async function countsByKey(store: EnvelopeStore, ring: KeyRing, db: DB): Promise<SecretKeyCounts> {
  const out: SecretKeyCounts = { table: store.table, current: 0, previous: 0, unknown: 0 };
  for (const { kekId, n } of await store.kekIds(db)) out[keyOf(ring, kekId)] += Number(n);
  return out;
}

export async function secretKeyCounts(env: NodeJS.ProcessEnv = process.env, db: DB = getDb()): Promise<SecretKeyCounts[]> {
  const ring = keyRingFromEnv(env);
  const out: SecretKeyCounts[] = [];
  for (const store of STORES) out.push(await countsByKey(store, ring, db));
  return out;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function perTable(counts: SecretKeyCounts[], key: 'previous' | 'unknown'): string {
  return counts
    .filter((c) => c[key] > 0)
    .map((c) => `${c.table} ${c[key]}`)
    .join(', ');
}

const UNKNOWN_KEY =
  'encrypted under a key this server does not have (neither DROBEK_MASTER_KEY nor DROBEK_MASTER_KEY_PREVIOUS)';
const UNKNOWN_KEY_REMEDY = [
  '  - DROBEK_MASTER_KEY was rotated: set the key used before as DROBEK_MASTER_KEY_PREVIOUS, start drobek, then run `task selfhost:rekey`.',
  '  - A backup was restored: use the DROBEK_MASTER_KEY it was made with (or set that key as DROBEK_MASTER_KEY_PREVIOUS).',
  '  - The key is lost: `task selfhost:rekey FORGET_UNKNOWN=1` deletes these secrets; their owners set them again in the dashboard.',
];

/** What the start does about the stored secrets' keys: refuse (`fatal`), or log a line and go on. */
export interface SecretKeysVerdict {
  level: 'fatal' | 'warn' | 'info';
  message: string;
}

/**
 * The start's verdict from `secretKeyCounts`: envelopes under an unknown key
 * stop a production start (a warning elsewhere — a development database may
 * hold test rows); envelopes still under the previous key ask for
 * `task selfhost:rekey`; a previous key nothing needs any more asks to be
 * removed. null = nothing to say.
 */
export function secretKeysStartCheck(counts: SecretKeyCounts[], env: NodeJS.ProcessEnv = process.env): SecretKeysVerdict | null {
  const unknown = counts.reduce((s, c) => s + c.unknown, 0);
  if (unknown > 0) {
    const what = `${plural(unknown, 'stored secret is', 'stored secrets are')} ${UNKNOWN_KEY} (${perTable(counts, 'unknown')})`;
    return env.NODE_ENV === 'production'
      ? { level: 'fatal', message: [`drobek refuses to start: ${what}.`, ...UNKNOWN_KEY_REMEDY].join('\n') }
      : { level: 'warn', message: [`${what} — they cannot be decrypted.`, ...UNKNOWN_KEY_REMEDY].join('\n') };
  }
  const previous = counts.reduce((s, c) => s + c.previous, 0);
  if (previous > 0) {
    return {
      level: 'warn',
      message: `${plural(previous, 'stored secret is', 'stored secrets are')} still encrypted under DROBEK_MASTER_KEY_PREVIOUS (${perTable(counts, 'previous')}) — run \`task selfhost:rekey\`, then remove DROBEK_MASTER_KEY_PREVIOUS.`,
    };
  }
  if (keyRingFromEnv(env).previous) {
    return {
      level: 'info',
      message: 'every stored secret is encrypted under DROBEK_MASTER_KEY — DROBEK_MASTER_KEY_PREVIOUS is no longer needed: remove it and restart drobek.',
    };
  }
  return null;
}

/** `secretKeyCounts` + `secretKeysStartCheck` — the check the server runs after its migrations. */
export async function storedSecretKeysCheck(env: NodeJS.ProcessEnv = process.env, db: DB = getDb()): Promise<SecretKeysVerdict | null> {
  return secretKeysStartCheck(await secretKeyCounts(env, db), env);
}

/** The start refusal for a malformed DROBEK_MASTER_KEY_PREVIOUS (its name only, never a value), or null. */
export function previousMasterKeyConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    previousKekFromEnv(env);
    return null;
  } catch {
    return [
      'drobek refuses to start: DROBEK_MASTER_KEY_PREVIOUS is not a valid key.',
      '  Set it to the DROBEK_MASTER_KEY drobek used before the rotation (64 hex characters, or the passphrase of at least 32 characters it was),',
      '  or remove it once `task selfhost:rekey` has re-wrapped every stored secret.',
    ].join('\n');
  }
}

/** What `rekeySecrets` did in one table. */
export interface RekeyCounts {
  table: SecretTable;
  /** Already under DROBEK_MASTER_KEY before the run. */
  current: number;
  /** Moved from DROBEK_MASTER_KEY_PREVIOUS to DROBEK_MASTER_KEY by this run. */
  rewrapped: number;
  /** Under a key this server does not have (`forgotten` of them deleted). */
  unknown: number;
  forgotten: number;
  /** Under DROBEK_MASTER_KEY_PREVIOUS, but the wrapped DEK does not open (damaged) — left as they are. */
  unreadable: number;
  /** Labels of the unknown (or forgotten) and the unreadable envelopes. */
  affected: string[];
}

/**
 * Re-wrap every envelope of DROBEK_MASTER_KEY_PREVIOUS under DROBEK_MASTER_KEY
 * (`task selfhost:rekey`). Idempotent: a second run finds everything under
 * the current key and changes nothing. Safe next to a running server: each
 * row is replaced only while it still holds the wrap that was read, so a
 * secret set again in the meantime (already under the current key) is left
 * alone. `forgetUnknown` deletes the envelopes no key of this server opens.
 */
export async function rekeySecrets(opts: { env?: NodeJS.ProcessEnv; db?: DB; forgetUnknown?: boolean } = {}): Promise<RekeyCounts[]> {
  const env = opts.env ?? process.env;
  const db = opts.db ?? getDb();
  const ring = keyRingFromEnv(env);
  const out: RekeyCounts[] = [];
  for (const store of STORES) {
    const before = await countsByKey(store, ring, db);
    const c: RekeyCounts = { table: store.table, current: before.current, rewrapped: 0, unknown: 0, forgotten: 0, unreadable: 0, affected: [] };
    for (const row of await store.notUnder(db, ring.current.id)) {
      const r = rewrapSecret(row, ring);
      if (r.status === 'rewrapped') {
        if (await row.replace(db, { wrappedDek: r.wrappedDek, kekId: r.kekId })) c.rewrapped += 1;
      } else if (r.status === 'unknown_key') {
        c.unknown += 1;
        c.affected.push(row.label);
        if (opts.forgetUnknown && (await row.remove(db))) c.forgotten += 1;
      } else if (r.status === 'unreadable') {
        c.unreadable += 1;
        c.affected.push(row.label);
      }
    }
    out.push(c);
  }
  return out;
}

/** The operator's summary of a `rekeySecrets` run; `ok` = nothing is left that the server cannot open. */
export function rekeyReport(counts: RekeyCounts[], env: NodeJS.ProcessEnv = process.env): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  for (const c of counts) {
    const parts = [`${c.rewrapped} re-wrapped`, `${c.current} already under DROBEK_MASTER_KEY`, `${c.unknown} under an unknown key${c.forgotten > 0 ? ` (${c.forgotten} deleted)` : ''}`];
    if (c.unreadable > 0) parts.push(`${c.unreadable} damaged`);
    lines.push(`${c.table}: ${parts.join(', ')}`);
    for (const label of c.affected) lines.push(`  - ${label}`);
  }
  const unknownLeft = counts.reduce((s, c) => s + c.unknown - c.forgotten, 0);
  const forgotten = counts.reduce((s, c) => s + c.forgotten, 0);
  const unreadable = counts.reduce((s, c) => s + c.unreadable, 0);
  if (forgotten > 0) {
    lines.push(`${plural(forgotten, 'secret', 'secrets')} under an unknown key deleted — their owners set them again in the dashboard.`);
  }
  if (unknownLeft > 0) {
    const [it, was] = unknownLeft === 1 ? ['it', 'it was'] : ['them', 'they were'];
    lines.push(
      `${plural(unknownLeft, 'stored secret is', 'stored secrets are')} ${UNKNOWN_KEY}: set DROBEK_MASTER_KEY_PREVIOUS to the key ${was} stored with and run \`task selfhost:rekey\` again — or, when that key is lost, \`task selfhost:rekey FORGET_UNKNOWN=1\` deletes ${it}.`
    );
  }
  if (unreadable > 0) {
    lines.push(
      `${plural(unreadable, 'stored secret', 'stored secrets')} under DROBEK_MASTER_KEY_PREVIOUS could not be opened (damaged) and stayed unchanged — ${unreadable === 1 ? 'its owner needs to set it' : 'their owners need to set them'} again.`
    );
  }
  const ok = unknownLeft === 0 && unreadable === 0;
  if (ok) {
    lines.push(
      keyRingFromEnv(env).previous
        ? 'every stored secret is encrypted under DROBEK_MASTER_KEY — remove DROBEK_MASTER_KEY_PREVIOUS and restart drobek.'
        : 'every stored secret is encrypted under DROBEK_MASTER_KEY.'
    );
  }
  return { ok, lines };
}
