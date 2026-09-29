/**
 * The module-config half of duplicating a gallery app (NSO-340; the files
 * half is @drobek/apps `duplicateAppFiles`). The source app's SAVED configs
 * (never its pending changes) are proposed to the copy through the normal
 * `configure` path: a change the module wants confirmed waits on the copy's
 * Modules page like any other. Before that the copy drops what belongs to the
 * source's owner: the whole `proxy` config (its upstreams are records of the
 * source workspace) and every value holding an e-mail address (admins,
 * notification recipients). Secrets live apart from configs and are never
 * read here.
 */
import { eq } from 'drizzle-orm';
import { getDb, moduleConfigs } from '@drobek/db';
import { isModuleError } from './errors.js';
import type { ModuleRuntime } from './runtime.js';

/** Modules whose config is never copied: it points at records of the source workspace (proxy), or would start calling an external API from the copy (sync). */
export const NOT_COPIED_MODULES: readonly string[] = ['proxy', 'sync'];

const EMAIL_RE = /[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+/;

function stripForCopy(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value === 'string') return EMAIL_RE.test(value) ? undefined : value;
  if (Array.isArray(value)) {
    return value.map(stripForCopy).filter((v) => v !== undefined);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const kept = stripForCopy(v);
      if (kept !== undefined) out[k] = kept;
    }
    return out;
  }
  return value;
}

/** The part of a saved `module` config a copy may propose, or null when nothing is left. */
export function configForCopy(module: string, config: unknown): Record<string, unknown> | null {
  if (NOT_COPIED_MODULES.includes(module)) return null;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const out = stripForCopy(config) as Record<string, unknown>;
  return Object.keys(out).length > 0 ? out : null;
}

export interface DuplicateConfigsInput {
  sourceAppId: string;
  target: { id: string; slug: string; workspaceId: string; workspaceSlug: string };
  actorUserId: string;
  surface: 'mcp' | 'web';
}

export interface DuplicateConfigsResult {
  applied: string[];
  pending: { module: string; changes: string[]; confirm_url?: string }[];
  skipped: { module: string; reason: 'not_copied' | 'not_enabled' | 'invalid' }[];
}

/** Propose the source app's saved module configs to the copy (see the file comment). */
export async function duplicateModuleConfigs(runtime: ModuleRuntime, input: DuplicateConfigsInput): Promise<DuplicateConfigsResult> {
  const rows = await getDb()
    .select({ module: moduleConfigs.module, config: moduleConfigs.config })
    .from(moduleConfigs)
    .where(eq(moduleConfigs.appId, input.sourceAppId))
    .orderBy(moduleConfigs.module);
  const out: DuplicateConfigsResult = { applied: [], pending: [], skipped: [] };
  for (const row of rows) {
    const patch = configForCopy(row.module, row.config);
    if (!patch) {
      if (NOT_COPIED_MODULES.includes(row.module)) out.skipped.push({ module: row.module, reason: 'not_copied' });
      continue;
    }
    try {
      const r = await runtime.configure({ app: input.target, module: row.module, patch, actorUserId: input.actorUserId, surface: input.surface });
      if (r.pending_confirmation.length > 0) {
        out.pending.push({ module: row.module, changes: r.pending_confirmation, ...(r.confirm_url ? { confirm_url: r.confirm_url } : {}) });
      } else {
        out.applied.push(row.module);
      }
    } catch (err) {
      if (!isModuleError(err)) throw err;
      out.skipped.push({ module: row.module, reason: err.code === 'module_not_enabled' || err.code === 'not_found' ? 'not_enabled' : 'invalid' });
    }
  }
  return out;
}
