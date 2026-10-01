/**
 * The choices a module page's config form needs (module-choices.ts), read
 * for one app: the workspace's registered upstreams (@drobek/proxy) with the
 * assignments of the module declaring `dashboard.editor: 'upstreams'`, the
 * collections of the module declaring `'collections'`, the forms of the
 * module declaring the `submissions` authority, and the workspace's value of
 * the limit an interval field names. The modules are found by the declared
 * capability, never by a module's name. A list that fails to load says so
 * and the field stays a text input; nothing here is a secret.
 *
 * Also the workspace's values of the limits fields name as what an empty
 * field means (`x-drobek-default-limit`).
 */
import type { AnyModule, ConfigChoices, HookApp, ModuleDashboardEditor, ModuleRuntime } from '@drobek/modules';
import { upstreamSummaries } from '@drobek/proxy';
import { collectionChoices, formChoices, intervalChoices, upstreamChoices, type ChoiceList } from './module-choices.js';
import type { ChoiceRequest } from './module-config.js';

type Json = Record<string, unknown>;

function asObject(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

interface Context {
  runtime: ModuleRuntime;
  app: HookApp;
  workspaceSlug: string;
  appSlug: string;
}

/** The active module declaring `editor`, when it is on for the app's workspace. */
async function editorModule(ctx: Context, editor: ModuleDashboardEditor): Promise<AnyModule | null> {
  const m = ctx.runtime.modules.find((x) => x.dashboard?.editor === editor);
  if (!m || !(await ctx.runtime.isEnabled(ctx.app.workspaceId, m.name))) return null;
  return m;
}

/** The keys of the `key` object in the effective config of module `m` for the app. */
async function configKeys(ctx: Context, m: AnyModule, key: string): Promise<string[]> {
  const view = await ctx.runtime.moduleView(ctx.app, m.name);
  return Object.keys(asObject(asObject(view.config)[key]));
}

function modulePage(ctx: Context, m: AnyModule, anchor: string): string {
  return `/workspaces/${encodeURIComponent(ctx.workspaceSlug)}/apps/${encodeURIComponent(ctx.appSlug)}/modules/${encodeURIComponent(m.name)}#${anchor}`;
}

async function upstreams(ctx: Context): Promise<ChoiceList> {
  const editor = await editorModule(ctx, 'upstreams');
  const assigned = new Set(editor ? await configKeys(ctx, editor, 'upstreams') : []);
  const registered = await upstreamSummaries(ctx.app.workspaceId);
  return upstreamChoices({
    upstreams: registered.map((u) => ({ name: u.name, assigned: assigned.has(u.name) })),
    register: { href: `/workspaces/${encodeURIComponent(ctx.workspaceSlug)}/upstreams`, label: 'Open the Upstreams page' },
    assign: editor ? { module: editor.name, href: modulePage(ctx, editor, 'upstreams'), label: 'Assign an upstream' } : null,
  });
}

async function collections(ctx: Context): Promise<ChoiceList> {
  const editor = await editorModule(ctx, 'collections');
  return collectionChoices({
    collections: editor ? await configKeys(ctx, editor, 'collections') : [],
    create: editor ? { module: editor.name, href: modulePage(ctx, editor, 'collections'), label: 'Create a collection' } : null,
  });
}

async function intervals(ctx: Context, limit: string | undefined): Promise<ChoiceList> {
  if (!limit) return intervalChoices(null);
  const value = (await ctx.runtime.workspaceLimits(ctx.app.workspaceId))[limit];
  return intervalChoices(typeof value === 'number' ? value : null);
}

async function forms(ctx: Context): Promise<ChoiceList> {
  const submissions = await ctx.runtime.submissions(ctx.app);
  return formChoices({ forms: submissions ? await submissions.forms() : [] });
}

const LOADERS: Record<ConfigChoices, (ctx: Context, request: ChoiceRequest) => Promise<ChoiceList>> = {
  upstreams: (ctx) => upstreams(ctx),
  collections: (ctx) => collections(ctx),
  intervals: (ctx, r) => intervals(ctx, r.minInterval),
  forms: (ctx) => forms(ctx),
};

const FAILED: Record<ConfigChoices, string> = {
  upstreams: 'The upstreams could not be loaded — enter the upstream’s name. Reload the page to try again.',
  collections: 'The collections could not be loaded — enter the collection’s name. Reload the page to try again.',
  intervals: 'The intervals could not be loaded — enter one like 15m, 1h or 1d.',
  forms: 'The app’s forms could not be loaded — enter the form’s name. Reload the page to try again.',
};

/** Every requested list, by its key (a list that failed to load carries `failed`). */
export async function loadChoices(ctx: Context, requests: readonly ChoiceRequest[]): Promise<Record<string, ChoiceList>> {
  const out: Record<string, ChoiceList> = {};
  for (const r of requests) {
    try {
      out[r.key] = await LOADERS[r.from](ctx, r);
    } catch {
      out[r.key] = { groups: [], missing: '', empty: { text: '' }, failed: FAILED[r.from] };
    }
  }
  return out;
}

/** The workspace's values of the limits `names` (a limit it does not have, or limits that cannot be read: left out). */
export async function loadFieldLimits(ctx: Pick<Context, 'runtime' | 'app'>, names: readonly string[]): Promise<Record<string, number>> {
  if (names.length === 0) return {};
  try {
    const limits = await ctx.runtime.workspaceLimits(ctx.app.workspaceId);
    return Object.fromEntries(names.flatMap((n) => (typeof limits[n] === 'number' && Number.isFinite(limits[n]) ? [[n, limits[n]]] : [])));
  } catch {
    return {};
  }
}
