/**
 * The proxy upstream tools (NSO-372, MCP parity with the dashboard's
 * workspace → Upstreams page): list_upstreams, register_upstream,
 * remove_upstream. Every body calls the SAME @drobek/proxy operation as the
 * dashboard (validation, the SSRF and port rules, the audit rows
 * `proxy.upstream.create` / `proxy.upstream.delete` — here as the agent).
 *
 * Workspace admins (and super-admins) only, like the page. A secret never
 * passes through MCP (hard rule 4): an upstream with `auth_type: "none"`
 * registers at once; `bearer` / `header` answer `registered: false` with
 * `secret_url`, the Upstreams page with the fields filled in, where the user
 * pastes the key and registers it. Removing needs `user_confirmed: true`:
 * every app that calls the upstream breaks at once.
 */
import { inArray } from 'drizzle-orm';
import { dashboardOrigin } from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { apps, getDb } from '@drobek/db';
import {
  ProxyError,
  checkUpstreamFields,
  createUpstream,
  deleteUpstream,
  getUpstream,
  listUpstreams,
  type ConfigureActor,
  type UpstreamView,
} from '@drobek/proxy';
import { authorizeWorkspace } from './access.js';
import { ToolError } from './errors.js';
import type { CallContext } from './tools.js';

async function adminActor(ctx: CallContext, workspace: unknown): Promise<{ slug: string; actor: ConfigureActor }> {
  const ws = await authorizeWorkspace(ctx.principal, String(workspace ?? ''), 'workspace-admin');
  return {
    slug: ws.slug,
    actor: {
      workspaceId: ws.id,
      actorUserId: ctx.principal.userId,
      role: ws.role,
      superAdmin: ctx.principal.superAdmin,
      actorKind: actorKindForSurface('mcp'),
    },
  };
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ProxyError)) throw err;
    if (err.code === 'forbidden' || err.code === 'not_found') throw new ToolError(err.code, err.message);
    throw new ToolError('invalid_params', err.message);
  }
}

function upstreamsPage(ctx: CallContext, slug: string): string {
  return `${dashboardOrigin(ctx.deps.env)}/workspaces/${encodeURIComponent(slug)}/upstreams`;
}

async function appSlugs(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb().select({ id: apps.id, slug: apps.slug }).from(apps).where(inArray(apps.id, ids));
  return new Map(rows.map((r) => [r.id, r.slug]));
}

function upstreamOut(u: UpstreamView, slugs: Map<string, string>) {
  return {
    name: u.name,
    base_url: u.baseUrl,
    allowed_methods: u.allowedMethods,
    allowed_path_prefixes: u.allowedPathPrefixes,
    auth_type: u.authType,
    auth_header_name: u.authHeaderName,
    has_secret: u.hasSecret,
    apps: u.allowedAppIds.map((id) => slugs.get(id)).filter((s): s is string => s !== undefined),
    created_at: u.createdAt,
  };
}

function assignHint(name: string): string {
  return `Assign it to an app with configure_module('proxy', { upstreams: { "${name}": { rules: { call: "user" } } } }); a workspace admin confirms the assignment in the dashboard.`;
}

// ── list_upstreams ───────────────────────────────────────────────────────────

export async function listUpstreamsTool(ctx: CallContext, args: { workspace: string }) {
  const { slug, actor } = await adminActor(ctx, args.workspace);
  const list = await run(() => listUpstreams(actor));
  const slugs = await appSlugs([...new Set(list.flatMap((u) => u.allowedAppIds))]);
  return { workspace: slug, upstreams: list.map((u) => upstreamOut(u, slugs)), upstreams_url: upstreamsPage(ctx, slug) };
}

// ── register_upstream ────────────────────────────────────────────────────────

export async function registerUpstreamTool(
  ctx: CallContext,
  args: {
    workspace: string;
    name: string;
    base_url: string;
    allowed_methods: string[];
    allowed_path_prefixes: string[];
    auth_type: string;
    auth_header_name?: string;
  }
) {
  const { slug, actor } = await adminActor(ctx, args.workspace);
  if (!Array.isArray(args.allowed_methods) || !Array.isArray(args.allowed_path_prefixes)) {
    throw new ToolError('invalid_params', '`allowed_methods` and `allowed_path_prefixes` must be lists, e.g. ["GET"] and ["/v1/"].');
  }
  const input = {
    name: args.name,
    baseUrl: args.base_url,
    allowedMethods: args.allowed_methods.map(String),
    allowedPathPrefixes: args.allowed_path_prefixes.map(String),
    authType: String(args.auth_type ?? ''),
    authHeaderName: args.auth_header_name ?? null,
    env: ctx.deps.env,
  };
  const fields = await run(async () => checkUpstreamFields(input));
  if (await run(() => getUpstream(actor, fields.name))) {
    throw new ToolError('upstream_already_registered', `An upstream named "${fields.name}" is already registered in workspace "${slug}" — list_upstreams shows it; remove_upstream removes it.`);
  }
  if (fields.authType !== 'none') {
    const q = new URLSearchParams({
      name: fields.name,
      baseUrl: fields.baseUrl,
      methods: fields.allowedMethods.join(' '),
      paths: fields.allowedPathPrefixes.join(' '),
      authType: fields.authType,
      ...(fields.authHeaderName ? { header: fields.authHeaderName } : {}),
    });
    return {
      registered: false,
      name: fields.name,
      secret_url: `${upstreamsPage(ctx, slug)}?${q.toString()}`,
      note: `This upstream needs a secret, and secrets never pass through MCP. Give the user secret_url: the Upstreams page with every field filled in — they paste the key and click Register. Never ask for the key in chat. Once it is registered, ${assignHint(fields.name)}`,
    };
  }
  const view = await run(() => createUpstream({ ...actor, ...input, secret: null }));
  return {
    registered: true,
    upstream: upstreamOut(view, new Map()),
    next: assignHint(view.name),
  };
}

// ── remove_upstream ──────────────────────────────────────────────────────────

export async function removeUpstreamTool(ctx: CallContext, args: { workspace: string; name: string; user_confirmed?: boolean }) {
  const { slug, actor } = await adminActor(ctx, args.workspace);
  if (typeof args.name !== 'string' || args.name.trim() === '') throw new ToolError('invalid_params', '`name` must be the name of a registered upstream.');
  const target = await run(() => getUpstream(actor, args.name.trim()));
  if (!target) throw new ToolError('not_found', `No upstream "${args.name.trim()}" is registered in workspace "${slug}" — list_upstreams lists them.`);
  const used = [...(await appSlugs(target.allowedAppIds)).values()];
  if (args.user_confirmed !== true) {
    throw new ToolError(
      'user_confirmation_required',
      `Removing "${target.name}" deletes it and its stored secret; ${used.length > 0 ? `the apps calling it (${used.join(', ')}) get 404 upstream_not_registered at once` : 'no app is allowed to call it yet'}. Ask the user whether to remove "${target.name}", and call again with user_confirmed: true only after they say yes.`,
      { name: target.name, apps: used }
    );
  }
  await run(() => deleteUpstream(actor, target.id));
  return {
    removed: target.name,
    apps: used,
    note: 'Registering it again creates a new record: every app assignment has to be confirmed again.',
  };
}
