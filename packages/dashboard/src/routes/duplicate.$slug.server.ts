/**
 * GET/POST /duplicate/:slug — server half: the gallery's Duplicate
 * button lands here. A signed-out visitor goes to /login and comes back
 * (`returnTo`). A signed-in one sees what gets copied, picks a workspace
 * where they are an editor+ (their personal workspace first) and a name, and
 * Duplicate creates the copy and opens it; the
 * redirect's query carries which module settings were applied, wait for
 * confirmation or were skipped (the copy's Overview shows them). An app that is not in the gallery,
 * whose owner does not allow duplicates, or a server without a gallery
 * answers a refusal page instead (`refused`).
 *
 * The copy: the published files (@drobek/apps `duplicateAppFiles`) and the
 * module settings proposed through the copy's own confirmation flow
 * (@drobek/modules `duplicateModuleConfigs`, surface `web`). The same rules
 * back the MCP tool `duplicate_app`.
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import {
  AppsError,
  DUPLICATE_NAME_MAX,
  copyName,
  defaultCopyName,
  duplicateAppFiles,
  duplicationSource,
  type DuplicationSource,
} from '@drobek/apps';
import { getSessionUser, type SessionUser } from '@drobek/auth';
import { duplicateModuleConfigs, moduleRuntime } from '@drobek/modules';
import { ensurePersonalWorkspace, listUserWorkspaces, roleAtLeast } from '@drobek/tenancy';
import { duplicatedAppUrl } from '../duplicate-result.server.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function headers() {
  return NO_STORE;
}

export type DuplicateRefusal = 'not_found' | 'not_duplicable' | 'gallery_disabled';

export interface DuplicateTarget {
  slug: string;
  name: string;
  personal: boolean;
}

export type DuplicateLoaderData =
  | { refused: DuplicateRefusal; message: string }
  | {
      refused: null;
      source: { slug: string; name: string; description: string; workspaceName: string; workspaceSlug: string; modules: string[] };
      workspaces: DuplicateTarget[];
      defaultName: string;
      nameMax: number;
    };

export interface DuplicateActionData {
  error: string;
}

async function signedIn(request: Request, slug: string): Promise<SessionUser> {
  const user = await getSessionUser(request);
  if (!user) throw redirect(`/login?returnTo=${encodeURIComponent(`/duplicate/${encodeURIComponent(slug)}`)}`);
  return user;
}

/** The workspaces the user may duplicate into: editor+, the personal one first. */
async function targets(user: SessionUser): Promise<(DuplicateTarget & { id: string })[]> {
  const personal = await ensurePersonalWorkspace(user.id, user.email);
  const rows = (await listUserWorkspaces(user.id)).filter((w) => roleAtLeast(w.role, 'editor'));
  const list = rows.map((w) => ({ id: w.id, slug: w.slug, name: w.name?.trim() || w.slug, personal: w.id === personal.id }));
  return [...list.filter((w) => w.personal), ...list.filter((w) => !w.personal)];
}

async function source(slug: string): Promise<DuplicationSource | { refused: DuplicateRefusal; message: string }> {
  try {
    return await duplicationSource(slug);
  } catch (err) {
    if (err instanceof AppsError && (err.code === 'not_found' || err.code === 'not_duplicable' || err.code === 'gallery_disabled')) {
      return { refused: err.code, message: err.message };
    }
    throw err;
  }
}

const REFUSAL_STATUS: Record<DuplicateRefusal, number> = { not_found: 404, not_duplicable: 403, gallery_disabled: 404 };

export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = String(params.slug ?? '');
  const user = await signedIn(request, slug);
  const src = await source(slug);
  if ('refused' in src) {
    return data<DuplicateLoaderData>(src, { status: REFUSAL_STATUS[src.refused], headers: NO_STORE });
  }
  return data<DuplicateLoaderData>(
    {
      refused: null,
      source: { slug: src.slug, name: src.name, description: src.description, workspaceName: src.workspaceName, workspaceSlug: src.workspaceSlug, modules: src.modules },
      workspaces: (await targets(user)).map(({ slug, name, personal }) => ({ slug, name, personal })),
      defaultName: defaultCopyName(src.name),
      nameMax: DUPLICATE_NAME_MAX,
    },
    { headers: NO_STORE }
  );
}

function fail(status: number, error: string) {
  return data<DuplicateActionData>({ error }, { status, headers: NO_STORE });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const slug = String(params.slug ?? '');
  const user = await signedIn(request, slug);
  const form = await request.formData();
  const src = await source(slug);
  if ('refused' in src) return fail(REFUSAL_STATUS[src.refused], src.message);

  const wanted = String(form.get('workspace') ?? '');
  const ws = (await targets(user)).find((w) => w.slug === wanted);
  if (!ws) return fail(403, 'Pick a workspace where you can create apps (editor or higher).');

  const rt = await moduleRuntime();
  let copy: { id: string; slug: string };
  try {
    const name = copyName(form.get('name'), src);
    copy = await duplicateAppFiles({
      source: src,
      workspaceId: ws.id,
      name,
      actor: { userId: user.id, kind: 'user' },
      maxApps: (await rt.workspaceLimits(ws.id)).APPS_MAX_PER_WORKSPACE,
    });
  } catch (err) {
    if (err instanceof AppsError) {
      if (err.code === 'rate_limited') return fail(429, err.message);
      if (err.code === 'limit_exceeded') return fail(409, err.message);
      if (err.code === 'invalid_settings') return fail(400, err.message);
      if (err.code === 'not_found' || err.code === 'slug_taken') return fail(409, err.message);
    }
    throw err;
  }
  await rt.runHook('onAppCreate', { id: copy.id, slug: copy.slug, workspaceId: ws.id });
  const modules = await duplicateModuleConfigs(rt, {
    sourceAppId: src.id,
    target: { id: copy.id, slug: copy.slug, workspaceId: ws.id, workspaceSlug: ws.slug },
    actorUserId: user.id,
    surface: 'web',
  });
  return redirect(duplicatedAppUrl(`/workspaces/${encodeURIComponent(ws.slug)}/apps/${encodeURIComponent(copy.slug)}`, src.slug, modules));
}
