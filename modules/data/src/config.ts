/**
 * The data module's per-app config (§5.0, §5.2):
 *
 *   { collections: { <name>: { schema?: <JSON Schema>, rules?: { read, create, update, delete } } } }
 *
 * Only declared collections exist: a request to any other name answers 404.
 * A rule left out takes DEFAULT_RULES (private to each signed-in user, admins
 * see all). `schema` is optional: with one, every write is validated and only
 * its properties can be filtered/sorted on.
 *
 * Changes that need the owner's confirmation (confirmRequired):
 *  - any operation opened to `public` — except `read` of a NEW collection that
 *    holds no records yet;
 *  - `read`, `update` or `delete` opened to every signed-in user (`user`) —
 *    `read` again except for a NEW collection that holds no records yet
 *    (NSO-322 M2: widening `owner|admin` to `user` shows every user's
 *    records to everyone signed in);
 *  - removing the schema of a collection that holds records;
 *  - removing a collection that holds records (NSO-324): confirming it
 *    purges them (onConfirmed, audited `data.collection.purge`). An empty
 *    collection goes without a confirmation.
 */
import { isValidRule, ruleIsPublic, z, type ConfirmContext, type ConfirmedContext } from '@drobek/modules';
import { DEFAULT_RULES, OPS, ruleAdmits, type Op, type Rules } from './access.js';
import { compileSchema } from './schema-validate.js';
import { countRecords, deleteCollectionRecords } from './store.js';

/** Collection names: URL-, config-path- and CSV-file-name-safe. */
export const COLLECTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const MAX_COLLECTIONS = 100;

const rule = z
  .string()
  .trim()
  .max(60)
  .refine(isValidRule, 'a rule is public, user, owner, admin or none — alternatives joined with | (e.g. "owner|admin")');

const rulesSchema = z.strictObject({
  read: rule.default(DEFAULT_RULES.read),
  create: rule.default(DEFAULT_RULES.create),
  update: rule.default(DEFAULT_RULES.update),
  delete: rule.default(DEFAULT_RULES.delete),
});

const jsonSchema = z.record(z.string(), z.unknown()).superRefine((schema, ctx) => {
  try {
    compileSchema(schema);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
  }
});

export const collectionConfigSchema = z.strictObject({
  /** A JSON Schema every record must match (optional). */
  schema: jsonSchema.optional(),
  /** Who may read / create / update / delete (each a rule; defaults: DEFAULT_RULES). */
  rules: rulesSchema.default({ ...DEFAULT_RULES }),
});

export type CollectionConfig = z.infer<typeof collectionConfigSchema>;

export const dataConfigSchema = z.strictObject({
  collections: z
    .record(
      z.string().regex(COLLECTION_NAME_RE, 'collection names start with a letter; letters, digits, - and _ (max 64)'),
      collectionConfigSchema
    )
    .refine((c) => Object.keys(c).length <= MAX_COLLECTIONS, `at most ${MAX_COLLECTIONS} collections`)
    .default({}),
});

export type DataConfig = z.infer<typeof dataConfigSchema>;

export const DATA_CONFIG_DEFAULTS: DataConfig = { collections: {} };

/**
 * The runtime's fallback for a stored config that fails dataConfigSchema
 * (NSO-323 M6) — e.g. a legacy import of more than MAX_COLLECTIONS
 * collections, or a hand-edited rule: every collection that is valid ON ITS
 * OWN is kept (all of them, even past the cap — none of them goes dark), an
 * invalid one is dropped (it answers 404) and named in `issues`. null when
 * `collections` is not an object at all (the runtime then uses the defaults).
 */
export function salvageDataConfig(merged: unknown): { config: DataConfig; issues: string[] } | null {
  const raw = merged && typeof merged === 'object' ? (merged as Record<string, unknown>).collections : undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const issues: string[] = [];
  for (const key of Object.keys(merged as object)) if (key !== 'collections') issues.push(`${key}: not a data setting (ignored)`);
  const collections: Record<string, CollectionConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!COLLECTION_NAME_RE.test(name)) {
      issues.push(`collections.${name}: not a valid collection name (dropped)`);
      continue;
    }
    const r = collectionConfigSchema.safeParse(value);
    if (!r.success) {
      const issue = r.error.issues[0];
      issues.push(`collections.${name}${issue?.path.length ? `.${issue.path.join('.')}` : ''}: ${issue?.message ?? 'invalid'} (dropped)`);
      continue;
    }
    collections[name] = r.data;
  }
  const n = Object.keys(collections).length;
  if (n > MAX_COLLECTIONS) issues.push(`collections: ${n} declared, at most ${MAX_COLLECTIONS} — all kept; remove some before the next configure_module`);
  return { config: { collections }, issues };
}

/** A declared collection's config, or null (undeclared → 404). */
export function collectionConfig(config: DataConfig, name: string): CollectionConfig | null {
  return Object.prototype.hasOwnProperty.call(config.collections, name) ? config.collections[name] : null;
}

/** The effective rules of a declared collection. */
export function rulesOf(c: CollectionConfig): Rules {
  return { ...DEFAULT_RULES, ...c.rules };
}

const OPENS: Record<Op, string> = {
  read: 'anyone, signed in or not, may read every record',
  create: 'anyone, signed in or not, may add records',
  update: 'anyone, signed in or not, may change every record',
  delete: 'anyone, signed in or not, may delete every record',
};

const USER_OPENS: Partial<Record<Op, string>> = {
  read: 'every signed-in user may read every record, not only their own',
  update: 'every signed-in user may change every record, not only their own',
  delete: 'every signed-in user may delete every record, not only their own',
};

/** The changes between two valid configs that wait for the owner (see the file header). */
export async function dataConfirmRequired(before: DataConfig, after: DataConfig, context: ConfirmContext): Promise<string[]> {
  const out: string[] = [];
  const counts = new Map<string, number>();
  const count = async (name: string) => {
    if (!counts.has(name)) counts.set(name, await countRecords(context.db, context.app.id, name));
    return counts.get(name)!;
  };
  for (const name of Object.keys(after.collections).sort()) {
    const a = collectionConfig(after, name)!;
    const b = collectionConfig(before, name);
    const ar = rulesOf(a);
    const br = b ? rulesOf(b) : null;
    for (const op of OPS) {
      const was = br ? `"${br[op]}"` : '(new collection)';
      if (ruleIsPublic(ar[op]) && !(br && ruleIsPublic(br[op]))) {
        if (op === 'read' && !br && (await count(name)) === 0) continue;
        out.push(`data.collections.${name}.rules.${op}: ${was} → "${ar[op]}" (${OPENS[op]})`);
      } else if (USER_OPENS[op] && ruleAdmits(ar[op], 'user') && !(br && ruleAdmits(br[op], 'user'))) {
        if (op === 'read' && !br && (await count(name)) === 0) continue;
        out.push(`data.collections.${name}.rules.${op}: ${was} → "${ar[op]}" (${USER_OPENS[op]})`);
      }
    }
    if (b?.schema && !a.schema) {
      const n = await count(name);
      if (n > 0) out.push(`data.collections.${name}.schema: removed while the collection holds ${n} record${n === 1 ? '' : 's'} (any shape can be stored afterwards)`);
    }
  }
  for (const name of removedCollections(before, after)) {
    const n = await count(name);
    if (n > 0) out.push(`data.collections.${name}: removed while it holds ${n} record${n === 1 ? '' : 's'} (confirming deletes them permanently)`);
  }
  return out;
}

/** Collections `before` declares and `after` does not, sorted. */
function removedCollections(before: DataConfig, after: DataConfig): string[] {
  return Object.keys(before.collections)
    .filter((name) => !collectionConfig(after, name))
    .sort();
}

/**
 * The owner confirmed a change (in the confirm transaction): the records of
 * every collection it removed are purged, so they neither linger invisibly
 * nor keep counting towards the quota — audited `data.collection.purge` with
 * the count (what is stored NOW, which may differ from the pending summary).
 */
export async function dataOnConfirmed(before: DataConfig, after: DataConfig, context: ConfirmedContext): Promise<void> {
  for (const collection of removedCollections(before, after)) {
    const records = await deleteCollectionRecords(context.db, context.app.id, collection);
    if (records > 0) await context.audit('collection.purge', { collection, records });
  }
}
