/**
 * GET/POST /workspaces/:slug/apps/:appSlug/modules/:module — server half
 * (M2-02, NSO-291). This is the `confirm_url` configure_module hands the
 * agent (`confirmUrl()` in @drobek/modules).
 *
 * GET (viewer+): the module's config as a form generated from its JSON
 * Schema, the pending change (a before → after diff per path, the module's
 * own confirmRequired strings + a plain-language risk note each), the
 * declared secrets (`hasSecret` + when set — NEVER a value), the module's
 * facts ("About this module": version, source, contract range, requires,
 * slots, contributions, its own error codes — NSO-347), and a dedicated
 * editor for a module that declares one in `dashboard.editor` — the
 * collections + rules editor (`collections`) or the per-app upstream
 * assignments (`upstreams`). The editor follows the declared capability,
 * never the module's name: a replacement module with the same capability
 * gets the same editor. A viewer gets the same page without any control.
 *
 * POST (editor+, `requireWorkspaceRole('editor')` BEFORE anything is read
 * from the form: a viewer → 403, a non-member → 404, anonymous → /login):
 *
 *  - `save-config`, `save-collection`, `add-collection`, `remove-collection`,
 *    `save-upstream`, `unassign-upstream` → a merge patch through the SAME
 *    configure path configure_module uses (the module's configSchema,
 *    confirmRequired, audit — actor `user`): a relaxation becomes a pending
 *    change rather than applying directly. Invalid → 400 with the errors at
 *    their fields;
 *  - `confirm` / `reject` → the pending decision (audit module.confirm /
 *    module.reject, actor `user`);
 *  - `set-secret` (set or rotate) / `remove-secret` → the encrypted module
 *    secret store; audit `module.secret_set` / `module.secret_remove` with the
 *    NAME only. The value is never logged, audited, echoed in the action data
 *    or rendered: a success redirects (PRG), a failure answers a message
 *    without it.
 *
 * A taken-down app (NSO-293, `apps.locked_reason`) refuses every change with
 * 423 `app_locked_by_admin` (like configure_module and the module-confirm
 * API); `reject` and `remove-secret` stay allowed (they only take away).
 *
 * NSO-346: an opt-in module that is not enabled for the workspace shows
 * "not enabled for this workspace" instead of the forms, and refuses every
 * change with 404 `module_not_enabled` (again except `reject` and
 * `remove-secret`).
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { eq } from 'drizzle-orm';
import { lockedByAdminError } from '@drobek/apps';
import { writeAudit, actorKindForSurface } from '@drobek/audit';
import { getDb, users } from '@drobek/db';
import {
  SecretStoreError,
  deleteModuleSecret,
  isModuleError,
  moduleNotEnabled,
  moduleRuntime,
  setModuleSecret,
  type ModuleDashboardEditor,
  type ModuleRuntime,
} from '@drobek/modules';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { appHeaderData } from '../app-page.server.js';
import { loadAppForView } from '../apps.server.js';
import {
  configDiff,
  confirmRoleOf,
  fieldErrors,
  fieldValues,
  formToConfig,
  leafFields,
  mergePatchBetween,
  riskNote,
  ruleFromForm,
  schemaFields,
  type FieldValue,
  type Issue,
} from '../module-config.js';
import { loadPendingBanner } from '../pending-banner.server.js';
import { canPublish } from '../view.js';

/**
 * The top-level config key each dedicated editor edits (instead of a form
 * field). A module opts in with `dashboard.editor` — a capability
 * declaration; the module's name plays no part.
 */
const EDITOR_CONFIG_KEY: Record<ModuleDashboardEditor, string> = {
  collections: 'collections',
  upstreams: 'upstreams',
};

/** The dedicated editor a module view declares, with the config key it takes over (null: the generic form only). */
function dedicatedEditor(view: { editor: ModuleDashboardEditor | null }): { kind: ModuleDashboardEditor; key: string } | null {
  return view.editor ? { kind: view.editor, key: EDITOR_CONFIG_KEY[view.editor] } : null;
}

/** Who may call a proxied upstream (`owner` has no meaning there). */
const CALL_PRINCIPALS = ['public', 'user', 'admin'] as const;

type Json = Record<string, unknown>;

function asObject(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

export interface ActionErrors {
  intent: string;
  /** The collection / upstream / secret the error belongs to (per-item forms). */
  target?: string;
  fields: Record<string, string[]>;
  general: string[];
  /** The submitted config inputs, re-shown next to the errors (never a secret). */
  values?: Record<string, FieldValue>;
}

function notFound(): never {
  throw data({ message: 'Not found' }, { status: 404 });
}

async function context(request: Request, params: LoaderFunctionArgs['params'], minRole: 'viewer' | 'editor') {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), minRole);
  const app = await loadAppForView(access.workspace.id, String(params.appSlug ?? ''));
  if (!app) notFound();
  const runtime = await moduleRuntime();
  const name = String(params.module ?? '');
  if (!runtime.get(name)) notFound();
  const hookApp = { id: app.id, slug: app.slug, workspaceId: access.workspace.id };
  return { access, app, runtime, name, hookApp };
}

async function emailOf(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.email ?? null;
}

function collectionsOf(config: unknown, ops: string[]) {
  const collections = asObject(asObject(config).collections);
  return Object.keys(collections)
    .sort()
    .map((name) => {
      const c = asObject(collections[name]);
      const rules = asObject(c.rules);
      return {
        name,
        rules: Object.fromEntries(ops.map((op) => [op, typeof rules[op] === 'string' ? (rules[op] as string) : 'none'])) as Record<string, string>,
        schemaText: c.schema === undefined ? '' : JSON.stringify(c.schema, null, 2),
      };
    });
}

function upstreamsOf(config: unknown, info: Record<string, unknown> | undefined) {
  const assigned = asObject(asObject(config).upstreams);
  const listed = Array.isArray(info?.upstreams) ? (info.upstreams as Json[]) : [];
  const out = new Map<string, { name: string; registered: boolean; assigned: boolean; call: string; rateLimit: number | null; hasSecret: boolean; methods: string[]; prefixes: string[] }>();
  for (const u of listed) {
    const name = String(u.name ?? '');
    if (!name) continue;
    // The assignment itself comes from the config (the source of truth); the
    // module's info adds the workspace facts (registered, secret set, allow-lists).
    const a = Object.prototype.hasOwnProperty.call(assigned, name) ? asObject(assigned[name]) : null;
    const call = asObject(a?.rules).call;
    out.set(name, {
      name,
      registered: u.registered !== false,
      assigned: a !== null,
      call: typeof call === 'string' ? call : 'user',
      rateLimit: typeof a?.rateLimit === 'number' ? a.rateLimit : null,
      hasSecret: u.hasSecret === true,
      methods: Array.isArray(u.allowedMethods) ? u.allowedMethods.map(String) : [],
      prefixes: Array.isArray(u.allowedPathPrefixes) ? u.allowedPathPrefixes.map(String) : [],
    });
  }
  // An assignment the info does not list (e.g. no appInfo) still shows up.
  for (const [name, a] of Object.entries(assigned)) {
    if (out.has(name)) continue;
    const rules = asObject(asObject(a).rules);
    const rl = asObject(a).rateLimit;
    out.set(name, {
      name,
      registered: false,
      assigned: true,
      call: typeof rules.call === 'string' ? rules.call : 'user',
      rateLimit: typeof rl === 'number' ? rl : null,
      hasSecret: false,
      methods: [],
      prefixes: [],
    });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { access, app, runtime, name, hookApp } = await context(request, params, 'viewer');
  const view = await runtime.moduleView(hookApp, name);
  const editor = dedicatedEditor(view);
  const fields = schemaFields(view.schema, editor ? [editor.key] : []);
  const ops = Object.keys(view.ops);

  const pending = view.pending
    ? {
        changes: view.pending.changes.map((text) => ({ text, risk: riskNote(text) })),
        diff: view.pending.after === null ? [] : configDiff(view.config, view.pending.after),
        invalid: view.pending.invalid ?? [],
        proposedAt: view.pending.proposed_at,
        proposedBy: await emailOf(view.pending.proposed_by),
        confirmRole: view.pending.confirm_role,
        canConfirm: view.pending.confirm_role !== 'admin' || confirmRoleOf(access.effectiveRole) === 'admin',
      }
    : null;

  const done = new URL(request.url).searchParams.get('done');
  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    app: { slug: app.slug },
    /** NSO-342: the app header + tabs (and the "taken down" banner, NSO-293). */
    header: await appHeaderData({ access, app }),
    module: { name: view.name, version: view.version, useWhen: view.use_when, confirms: view.confirms },
    /** NSO-347: "About this module" — never a path on disk, never a secret. */
    about: {
      version: view.version,
      source: view.source,
      contract: view.contract,
      availability: view.availability,
      requires: view.requires,
      slots: view.slots,
      contributes: view.contributes,
      editor: view.editor,
    },
    errors: view.errors,
    /** The workspace Modules page (the same facts for every module of the server). */
    modulesHref: `/workspaces/${encodeURIComponent(access.workspace.slug)}/modules#module-${encodeURIComponent(view.name)}`,
    /** NSO-346: an opt-in module off for this workspace — the page shows a notice instead of the forms. */
    enabled: view.enabled,
    fields,
    values: fieldValues(fields, view.config),
    pending,
    secrets: view.secrets.map((s) => ({ name: s.name, description: s.description, required: s.required, hasSecret: s.hasSecret, updatedAt: s.updated_at })),
    editor: editor?.kind ?? null,
    ops: ops.map((op) => ({ op, meaning: view.ops[op] })),
    collections: editor?.kind === 'collections' ? collectionsOf(view.config, ops) : [],
    upstreams: editor?.kind === 'upstreams' ? upstreamsOf(view.config, view.info) : [],
    banner: await loadPendingBanner(app, access.workspace.slug, app.slug),
    canEdit: canPublish(access.effectiveRole),
    done: done && /^[a-z-]{1,32}$/.test(done) ? done : null,
  };
}

function pageUrl(ws: string, appSlug: string, module: string, done: string, anchor = ''): string {
  return `/workspaces/${encodeURIComponent(ws)}/apps/${encodeURIComponent(appSlug)}/modules/${encodeURIComponent(module)}?done=${done}${anchor}`;
}

function failure(status: number, errors: ActionErrors) {
  return data({ errors }, { status });
}

export async function action({ request, params }: ActionFunctionArgs) {
  // Role GATE first: a viewer → 403 before the form is even read.
  const { access, app, runtime, name, hookApp } = await context(request, params, 'editor');
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const ws = access.workspace.slug;
  const back = (done: string, anchor = '') => redirect(pageUrl(ws, app.slug, name, done, anchor));

  // NSO-293: a taken-down app's module setup cannot change (reject / remove-secret only take away).
  if (app.lockedReason && intent !== 'reject' && intent !== 'remove-secret') {
    return failure(423, { intent, fields: {}, general: [lockedByAdminError(app.lockedReason).message] });
  }
  // NSO-346: an opt-in module off for the workspace takes no change (reject / remove-secret only take away).
  if (intent !== 'reject' && intent !== 'remove-secret' && !(await runtime.isEnabled(hookApp.workspaceId, name))) {
    return failure(404, { intent, fields: {}, general: [moduleNotEnabled(name).message] });
  }

  // ── pending decision ──
  if (intent === 'confirm' || intent === 'reject') {
    try {
      const input = { app: hookApp, module: name, userId: access.user.id, role: confirmRoleOf(access.effectiveRole) };
      if (intent === 'confirm') await runtime.confirm(input);
      else await runtime.reject(input);
    } catch (err) {
      if (!isModuleError(err)) throw err;
      const issues = asObject(err.details).issues;
      const extra = Array.isArray(issues) ? (issues as Issue[]).map((i) => `${i.path}: ${i.message}`) : [];
      return failure(err.status, { intent, fields: {}, general: [err.message, ...extra] });
    }
    return back(intent === 'confirm' ? 'confirmed' : 'rejected', '#pending');
  }

  // ── secrets (write-only) ──
  if (intent === 'set-secret' || intent === 'remove-secret') {
    return secretAction(runtime, { intent, form, name, hookApp, userId: access.user.id, back });
  }

  // ── config (through the configure path) ──
  const view = await runtime.moduleView(hookApp, name);
  const config = asObject(view.config);
  const editor = dedicatedEditor(view);
  const configure = async (
    patch: unknown,
    err: { target?: string; fieldPaths: string[]; values?: Record<string, FieldValue>; anchor: string }
  ) => {
    if (patch === undefined) return back('unchanged', err.anchor);
    try {
      const out = await runtime.configure({
        app: { ...hookApp, workspaceSlug: ws },
        module: name,
        patch,
        actorUserId: access.user.id,
        surface: 'web',
      });
      return back(out.unchanged ? 'unchanged' : out.applied ? 'applied' : 'pending', out.applied ? err.anchor : '#pending');
    } catch (e) {
      if (!isModuleError(e)) throw e;
      const issues = asObject(e.details).issues;
      const mapped = Array.isArray(issues) ? fieldErrors(issues as Issue[], err.fieldPaths) : { fields: {}, general: [] as string[] };
      if (!Array.isArray(issues) || mapped.general.length === 0) mapped.general.unshift(e.message);
      return failure(e.status === 404 ? 400 : e.status, { intent, target: err.target, ...mapped, values: err.values });
    }
  };

  switch (intent) {
    case 'save-config': {
      const fields = schemaFields(view.schema, editor ? [editor.key] : []);
      const parsed = formToConfig(fields, form);
      const paths = leafFields(fields).map((f) => f.path);
      if (Object.keys(parsed.errors).length > 0) {
        const pre: Record<string, string[]> = {};
        for (const [p, m] of Object.entries(parsed.errors)) pre[p] = [m];
        return failure(400, { intent, fields: pre, general: ['Fix the marked fields.'], values: parsed.values });
      }
      // Keys the form does not show (a dedicated editor's) keep their value.
      const desired: Json = structuredClone(config);
      for (const f of fields) {
        if (parsed.value[f.key] === undefined) delete desired[f.key];
        else desired[f.key] = parsed.value[f.key];
      }
      return configure(mergePatchBetween(config, desired), { fieldPaths: paths, values: parsed.values, anchor: '#config' });
    }

    case 'add-collection':
    case 'save-collection':
    case 'remove-collection': {
      if (editor?.kind !== 'collections') return failure(400, { intent, fields: {}, general: ['This module has no collections.'] });
      const collection = String(form.get('collection') ?? '').trim();
      const collections = asObject(config.collections);
      const exists = Object.prototype.hasOwnProperty.call(collections, collection);
      if (!collection) return failure(400, { intent, fields: {}, general: ['Enter a collection name.'] });
      if (intent === 'add-collection') {
        if (exists) return failure(400, { intent, fields: {}, general: [`The collection "${collection}" already exists.`] });
        return configure({ collections: { [collection]: {} } }, { fieldPaths: [], anchor: '#collections' });
      }
      if (!exists) return failure(400, { intent, target: collection, fields: {}, general: [`No collection "${collection}".`] });
      if (intent === 'remove-collection') {
        return configure({ collections: { [collection]: null } }, { target: collection, fieldPaths: [], anchor: '#collections' });
      }
      const ops = Object.keys(view.ops);
      const rules = Object.fromEntries(ops.map((op) => [op, ruleFromForm(form, op)]));
      const schemaText = String(form.get('schema') ?? '');
      const schemaPath = `collections.${collection}.schema`;
      const next: Json = { ...asObject(collections[collection]), rules };
      if (schemaText.trim() === '') delete next.schema;
      else {
        try {
          const parsed = JSON.parse(schemaText) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('a JSON Schema is a JSON object');
          next.schema = parsed;
        } catch (e) {
          return failure(400, { intent, target: collection, fields: { [schemaPath]: [`Not a valid JSON Schema: ${(e as Error).message}`] }, general: [], values: { [schemaPath]: schemaText } });
        }
      }
      const desired: Json = structuredClone(config);
      desired.collections = { ...collections, [collection]: next };
      return configure(mergePatchBetween(config, desired), {
        target: collection,
        fieldPaths: [schemaPath, ...ops.map((op) => `collections.${collection}.rules.${op}`)],
        values: { [schemaPath]: schemaText },
        anchor: '#collections',
      });
    }

    case 'save-upstream':
    case 'unassign-upstream': {
      if (editor?.kind !== 'upstreams') return failure(400, { intent, fields: {}, general: ['This module has no upstreams.'] });
      const upstream = String(form.get('upstream') ?? '').trim();
      if (!upstream) return failure(400, { intent, fields: {}, general: ['Pick an upstream.'] });
      const upstreams = asObject(config.upstreams);
      if (intent === 'unassign-upstream') {
        if (!Object.prototype.hasOwnProperty.call(upstreams, upstream)) return back('unchanged', '#upstreams');
        return configure({ upstreams: { [upstream]: null } }, { target: upstream, fieldPaths: [], anchor: '#upstreams' });
      }
      const call = ruleFromForm(form, 'call', CALL_PRINCIPALS);
      const rlText = String(form.get('rateLimit') ?? '').trim();
      const next: Json = { rules: { call } };
      const rlPath = `upstreams.${upstream}.rateLimit`;
      if (rlText !== '') {
        const n = Number(rlText);
        if (!Number.isInteger(n)) return failure(400, { intent, target: upstream, fields: { [rlPath]: ['Enter a whole number of calls per minute.'] }, general: [] });
        next.rateLimit = n;
      }
      const desired: Json = structuredClone(config);
      desired.upstreams = { ...upstreams, [upstream]: next };
      return configure(mergePatchBetween(config, desired), {
        target: upstream,
        fieldPaths: [rlPath, `upstreams.${upstream}.rules.call`, `upstreams.${upstream}`],
        anchor: '#upstreams',
      });
    }

    default:
      return failure(400, { intent, fields: {}, general: ['Unknown action.'] });
  }
}

async function secretAction(
  runtime: ModuleRuntime,
  input: {
    intent: 'set-secret' | 'remove-secret';
    form: FormData;
    name: string;
    hookApp: { id: string; slug: string; workspaceId: string };
    userId: string;
    back: (done: string, anchor?: string) => Response;
  }
) {
  const { intent, form, name, hookApp } = input;
  const secret = String(form.get('secret') ?? '');
  const declared = runtime.get(name)?.secrets ?? [];
  if (!declared.some((s) => s.name === secret)) {
    return failure(400, { intent, target: secret, fields: {}, general: ['This module declares no such secret.'] });
  }
  const audit = (action: string, meta: Record<string, unknown>) =>
    writeAudit({
      workspaceId: hookApp.workspaceId,
      actorUserId: input.userId,
      actorKind: actorKindForSurface('web'),
      action,
      subjectType: 'app',
      target: hookApp.slug,
      meta: { module: name, name: secret, ...meta },
    });

  if (intent === 'remove-secret') {
    const removed = await deleteModuleSecret(hookApp.id, name, secret);
    if (removed) await audit('module.secret_remove', {});
    return input.back(removed ? 'secret-removed' : 'unchanged', '#secrets');
  }

  const raw = form.get('value');
  const value = typeof raw === 'string' ? raw : '';
  if (value.trim() === '') {
    return failure(400, { intent, target: secret, fields: {}, general: ['Enter the secret value.'] });
  }
  const view = await runtime.moduleView(hookApp, name);
  const rotated = view.secrets.some((s) => s.name === secret && s.hasSecret);
  try {
    await setModuleSecret({ appId: hookApp.id, module: name, name: secret, value });
  } catch (err) {
    // The store's messages name the problem, never the value.
    if (err instanceof SecretStoreError) return failure(400, { intent, target: secret, fields: {}, general: [`Not saved: ${err.message}.`] });
    throw err;
  }
  await audit('module.secret_set', { rotated });
  return input.back(rotated ? 'secret-rotated' : 'secret-set', '#secrets');
}
