/**
 * drobek-module-acme-crm — the example EXTERNAL platform module: generated
 * with create-drobek-module, never a dependency of the drobek server. An
 * operator packs it and installs it into DROBEK_MODULES_DIR:
 *
 *   task selfhost:module:add -- drobek-module-acme-crm-0.1.0.tgz
 *   DROBEK_MODULES=…,drobek-module-acme-crm
 *
 *   GET  /__drobek/v1/acmecrm → { contacts, upstream }  (signed-in end users)
 *   POST /__drobek/v1/acmecrm → the new contact          ({ email, name?, fields? })
 *   drobek.acmecrm.list() / add(contact)
 *   config { tags, fields } — tags every new contact gets, the custom fields.
 *
 * `availability: 'opt-in'`: a super-admin (or the limits provider's
 * MODULE_ENABLED_ACMECRM) turns it on per workspace. It contributes an
 * `auth.signedIn` observer: every sign-in to an app of a workspace where it
 * is on becomes a contact (source `sign-in`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { count, desc, eq } from 'drizzle-orm';
import { ModuleError, defineModule, defineSignInObserver, z, type DB } from '@drobek/modules';
import { contacts } from './schema.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The SDK entry next to this file: dist/sdk.js when built, src/sdk.ts in a source checkout. */
const sdkEntry = existsSync(here('./sdk.js')) ? here('./sdk.js') : here('./sdk.ts');

const FIELD_KEY = /^[a-z][a-z0-9_]{0,30}$/;

export const config = z.object({
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .meta({ title: 'Tags', description: 'Every contact the app adds gets these tags, e.g. “newsletter”.' }),
  fields: z
    .record(
      z.string().regex(FIELD_KEY),
      z.object({
        label: z.string().trim().min(1).max(60).meta({ title: 'Label' }),
        required: z.boolean().meta({ title: 'Required' }),
      })
    )
    .meta({ title: 'Custom fields', description: 'Extra values a contact may carry, by key (lower case letters, digits, _).' }),
});
export type Config = z.infer<typeof config>;

export const CONTACTS_LIMIT = 'ACMECRM_CONTACTS_PER_APP';

/** What `drobek.acmecrm` looks like to the app (sdk.d.ts); src/sdk.ts implements it. */
const SDK_TYPES = `
export interface Contact {
  id: number;
  email: string;
  name: string | null;
  /** "app" (added by the app) or "sign-in" (recorded when the user signed in) */
  source: 'app' | 'sign-in';
  tags: string[];
  fields: Record<string, string>;
  created_at: string;
}
export interface NewContact {
  email: string;
  /** 1–120 characters */
  name?: string;
  /** values of the custom fields the config declares (key → text, at most 500 characters) */
  fields?: Record<string, string>;
}
export interface Api {
  /** The app's contacts, newest first (at most 100); upstream: the owner set ACMECRM_API_KEY. Signed-in users only. */
  list(): Promise<{ contacts: Contact[]; upstream: boolean }>;
  /** Add a contact (signed-in users only); an address the app has already is crm_duplicate. */
  add(contact: NewContact): Promise<Contact>;
}
`;

type Row = typeof contacts.$inferSelect;

const contactView = (row: Row) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  source: row.source,
  tags: row.tags,
  fields: row.fields,
  created_at: row.createdAt.toISOString(),
});

async function contactCount(db: DB, appId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(contacts).where(eq(contacts.appId, appId));
  return Number(row?.n ?? 0);
}

/** The custom field values against the config: unknown keys and missing required fields are refused. */
function fieldIssues(values: Record<string, string>, declared: Config['fields']): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  for (const key of Object.keys(values)) {
    if (!(key in declared)) issues.push({ path: `fields.${key}`, message: 'the config declares no such field' });
  }
  for (const [key, f] of Object.entries(declared)) {
    if (f.required && !values[key]?.trim()) issues.push({ path: `fields.${key}`, message: `${f.label} is required` });
  }
  return issues;
}

export const signInObserver = defineSignInObserver({
  id: 'acmecrm-contacts',
  async onSignIn({ app, user, db }) {
    await db
      .insert(contacts)
      .values({ appId: app.id, email: user.email, name: user.name ?? null, source: 'sign-in' })
      .onConflictDoNothing();
  },
});

export default defineModule<Config>({
  name: 'acmecrm',
  version: '0.1.0',
  contract: '^1.2',
  availability: 'opt-in',
  requires: ['auth'],
  skill: {
    useWhen: 'the app collects contacts (people and their e-mail addresses) into a CRM list on the server',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  configSchema: config,
  configDefaults: { tags: [], fields: {} },
  // Names only: the owner sets the value in the dashboard; ctx.secrets.get reads it.
  secrets: [{ name: 'ACMECRM_API_KEY', description: 'The key of the Acme CRM API the contacts are synced to (optional)' }],
  // The operator (or the limits provider, per workspace) may change the default.
  limits: [{ env: CONTACTS_LIMIT, default: 1000, meaning: 'contacts one app keeps' }],
  // Every code a route throws besides the core ones (a ModuleError with another code is a 500).
  errors: [
    {
      code: 'crm_duplicate',
      meaning: 'HTTP 409. The app already has a contact with this e-mail address (`details.email`).',
      fix: 'Tell the user the address is on the list already; list() shows the existing contact.',
    },
  ],
  contributes: { 'auth.signedIn': signInObserver },
  routes(r) {
    r.get('/', { rule: 'user' }, async (_req, ctx) => {
      const rows = await ctx.db.select().from(contacts).where(eq(contacts.appId, ctx.app.id)).orderBy(desc(contacts.id)).limit(100);
      // Call the upstream with the key here; the value never leaves the server.
      const key = await ctx.secrets.get('ACMECRM_API_KEY');
      return { contacts: rows.map(contactView), upstream: key !== null };
    });
    r.post(
      '/',
      {
        rule: 'user',
        body: z.object({
          email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
          name: z.string().trim().min(1).max(120).optional(),
          fields: z.record(z.string(), z.string().max(500)).optional(),
        }),
        maxBodyBytes: 16_384,
      },
      async (req, ctx) => {
        const values = req.body.fields ?? {};
        const issues = fieldIssues(values, ctx.config.fields);
        if (issues.length > 0) throw new ModuleError('invalid_request', 'The contact does not match the custom fields.', { details: issues });
        const max = (await ctx.limits())[CONTACTS_LIMIT];
        if ((await contactCount(ctx.db, ctx.app.id)) >= max) {
          throw new ModuleError('quota_exceeded', `This app keeps at most ${max} contacts.`, { details: { limit: CONTACTS_LIMIT, max } });
        }
        const [row] = await ctx.db
          .insert(contacts)
          .values({ appId: ctx.app.id, email: req.body.email, name: req.body.name ?? null, source: 'app', tags: ctx.config.tags, fields: values })
          .onConflictDoNothing()
          .returning();
        if (!row) {
          throw new ModuleError('crm_duplicate', `${req.body.email} is on the list already.`, { status: 409, details: { email: req.body.email } });
        }
        await ctx.audit('add', { id: row.id });
        return contactView(row);
      }
    );
  },
  sdk: { entry: sdkEntry, types: SDK_TYPES },
  migrations: { folder: here('../migrations') },
});
