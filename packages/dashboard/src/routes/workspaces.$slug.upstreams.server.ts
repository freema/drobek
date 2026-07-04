/**
 * GET/POST /workspaces/:slug/upstreams — server half (PHY-59). The workspace-level
 * BFF proxy config: list registered upstreams, register a new one, delete one.
 *
 * workspace-admin / super-admin ONLY (editor/viewer → 403, non-member → 404) via
 * requireWorkspaceRole('workspace-admin'). The secret input is WRITE-ONLY — it is
 * accepted on create, encrypted by @drobek/proxy, and NEVER read back: the loader
 * returns only `hasSecret`, never the value.
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import {
  createUpstream,
  deleteUpstream,
  listUpstreams,
  ProxyError,
  proxyErrorStatus,
} from '@drobek/proxy';
import { requireWorkspaceRole } from '@drobek/tenancy';

function splitList(raw: string): string[] {
  return String(raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'workspace-admin'
  );
  const upstreams = await listUpstreams({
    workspaceId: access.workspace.id,
    actorUserId: access.user.id,
    role: access.effectiveRole,
    superAdmin: access.superAdmin,
  });
  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    upstreams,
    role: access.effectiveRole,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'workspace-admin'
  );
  const actor = {
    workspaceId: access.workspace.id,
    actorUserId: access.user.id,
    role: access.effectiveRole,
    superAdmin: access.superAdmin,
  };
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const back = `/workspaces/${access.workspace.slug}/upstreams`;

  try {
    if (intent === 'delete') {
      await deleteUpstream(actor, String(form.get('id') ?? ''));
      return redirect(back);
    }
    if (intent === 'create') {
      await createUpstream({
        ...actor,
        name: String(form.get('name') ?? ''),
        baseUrl: String(form.get('baseUrl') ?? ''),
        allowedMethods: splitList(String(form.get('methods') ?? '')),
        allowedPathPrefixes: splitList(String(form.get('pathPrefixes') ?? '')),
        authType: String(form.get('authType') ?? 'none'),
        authHeaderName: String(form.get('authHeaderName') ?? '') || null,
        // Write-only: consumed here, encrypted, never returned.
        secret: String(form.get('secret') ?? '') || null,
      });
      return redirect(back);
    }
    return data({ error: 'Unsupported action.' }, { status: 400 });
  } catch (err) {
    if (err instanceof ProxyError) {
      return data({ error: err.message }, { status: proxyErrorStatus(err.code) });
    }
    throw err;
  }
}
