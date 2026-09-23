/**
 * `module_configs` access (M1-01): one row per (app, module) with the config
 * that was SET (sparse — defaults fill the rest when read) and at most ONE
 * pending change waiting for the owner's confirmation.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, moduleConfigs, type DB } from '@drobek/db';

/** A change held for the owner's confirmation (confirmRequired). */
export interface PendingChange {
  /** The RFC 7396 merge patch the agent sent — applied on top of the config at confirm time. */
  patch: Record<string, unknown>;
  /** What needs confirming, verbatim from the module's confirmRequired. */
  changes: string[];
  proposed_at: string;
  /** The dashboard user whose agent proposed it. */
  proposed_by: string | null;
}

export interface ConfigRow {
  config: Record<string, unknown>;
  pending: PendingChange | null;
  updatedAt: Date | null;
}

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
type Executor = DB | Tx;

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asPending(v: unknown): PendingChange | null {
  const o = asObject(v);
  if (!('patch' in o)) return null;
  return {
    patch: asObject(o.patch),
    changes: Array.isArray(o.changes) ? o.changes.map(String) : [],
    proposed_at: String(o.proposed_at ?? ''),
    proposed_by: typeof o.proposed_by === 'string' ? o.proposed_by : null,
  };
}

export async function readConfigRow(appId: string, module: string, executor: Executor = getDb()): Promise<ConfigRow> {
  const [row] = await executor
    .select()
    .from(moduleConfigs)
    .where(and(eq(moduleConfigs.appId, appId), eq(moduleConfigs.module, module)))
    .limit(1);
  if (!row) return { config: {}, pending: null, updatedAt: null };
  return { config: asObject(row.config), pending: asPending(row.pending), updatedAt: row.updatedAt };
}

/** Every configured module of one app (module → row). */
export async function readConfigRows(appId: string, modules: string[]): Promise<Map<string, ConfigRow>> {
  const out = new Map<string, ConfigRow>();
  if (modules.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(moduleConfigs)
    .where(and(eq(moduleConfigs.appId, appId), inArray(moduleConfigs.module, modules)));
  for (const r of rows) {
    out.set(r.module, { config: asObject(r.config), pending: asPending(r.pending), updatedAt: r.updatedAt });
  }
  return out;
}

/**
 * Run `fn` with the (app, module) row locked (SELECT … FOR UPDATE inside a
 * transaction; the row is created first when missing), so two concurrent
 * configure/confirm calls serialise instead of losing an update.
 */
export async function withLockedConfig<T>(
  appId: string,
  module: string,
  fn: (row: ConfigRow, write: (next: { config?: Record<string, unknown>; pending?: PendingChange | null }) => Promise<void>, tx: Tx) => Promise<T>
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.insert(moduleConfigs).values({ appId, module }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(moduleConfigs)
      .where(and(eq(moduleConfigs.appId, appId), eq(moduleConfigs.module, module)))
      .for('update');
    const current: ConfigRow = {
      config: asObject(row?.config),
      pending: asPending(row?.pending),
      updatedAt: row?.updatedAt ?? null,
    };
    const write = async (next: { config?: Record<string, unknown>; pending?: PendingChange | null }) => {
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (next.config !== undefined) set.config = next.config;
      if (next.pending !== undefined) set.pending = next.pending;
      await tx
        .update(moduleConfigs)
        .set(set)
        .where(and(eq(moduleConfigs.appId, appId), eq(moduleConfigs.module, module)));
    };
    return fn(current, write, tx);
  });
}
