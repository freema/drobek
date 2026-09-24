/**
 * GET/POST /workspaces/:slug/apps/:appSlug/domains — server half (M3-01,
 * NSO-292): the app's custom domains.
 *
 * GET (viewer+): every domain with its state (pending / verified / primary),
 * the last check's problem and the two DNS records to create
 * (`CNAME <host> → <slug>.<APPS_DOMAIN>`, `TXT _drobek.<host> =
 * drobek-verify=<token>`). A viewer sees everything but no controls.
 *
 * POST (editor+, re-enforced here by requireWorkspaceRole('editor') — a
 * viewer gets 403, a non-member 404, anonymous a /login redirect; the global
 * Origin check already refused cross-origin posts, incl. from app hosts and
 * custom domains): `intent` =
 *   add      { hostname }  → @drobek/domains addDomain (validation, limit, audit)
 *   verify   { id }        → DNS lookup now (TXT + CNAME), stores the verdict
 *   primary  { id }        → the production host redirects (302) to this domain
 *   unprimary              → no redirect
 *   remove   { id }        → detach (Caddy's certificate expires on its own)
 * Expected failures come back as `{ error, code }` with the DomainsError status
 * (e.g. 403 `limit_exceeded` for the (DOMAINS_MAX_PER_APP + 1)-th domain).
 * DOMAINS_MAX_PER_APP is the WORKSPACE's value (NSO-329: the limits provider's
 * plan, else the env); 0 = custom domains off — the page says so and every
 * add answers `limit_exceeded`.
 */
import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { actorKindForSurface } from '@drobek/audit';
import { appsOrigin, publishedUrl } from '@drobek/apps';
import {
  DomainsError,
  addDomain,
  cnameTarget,
  domainsErrorStatus,
  listDomains,
  removeDomain,
  setPrimaryDomain,
  verifyDomain,
  type DomainApp,
} from '@drobek/domains';
import { moduleRuntime } from '@drobek/modules';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { loadAppForView } from '../apps.server.js';
import { canPublish } from '../view.js';

/** The workspace's DOMAINS_MAX_PER_APP (limits provider plan or env default; 0 = off). */
async function maxDomainsPerApp(workspaceId: string): Promise<number> {
  return (await (await moduleRuntime()).workspaceLimits(workspaceId)).DOMAINS_MAX_PER_APP;
}

async function appOf(workspaceId: string, appSlug: string): Promise<DomainApp> {
  const app = await loadAppForView(workspaceId, appSlug);
  if (!app) throw data({ message: 'Not found' }, { status: 404 });
  return { id: app.id, slug: app.slug, workspaceId };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await appOf(access.workspace.id, String(params.appSlug ?? ''));
  const domains = await listDomains(app);
  const { scheme } = appsOrigin();
  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    app: { slug: app.slug, defaultUrl: publishedUrl(app.slug) },
    cnameTarget: cnameTarget(app.slug, appsOrigin().domain),
    scheme,
    maxPerApp: await maxDomainsPerApp(access.workspace.id),
    canEdit: canPublish(access.effectiveRole),
    domains: domains.map((d) => ({
      id: d.id,
      hostname: d.hostname,
      verified: d.verified,
      isPrimary: d.isPrimary,
      certState: d.certState,
      lastError: d.lastError,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      lastCheckAt: d.lastCheckAt?.toISOString() ?? null,
      instructions: d.instructions,
    })),
  };
}

export type DomainsActionData =
  | { ok: true; intent: string; message: string; hostname?: string }
  | { ok: false; intent: string; error: string; code: string; hostname?: string };

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'editor');
  const app = await appOf(access.workspace.id, String(params.appSlug ?? ''));
  // Dashboard surface → a human actor (PHY-85), server-derived.
  const actor = { userId: access.user.id, kind: actorKindForSurface('web') };
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const id = String(form.get('id') ?? '');

  const done = (message: string, hostname?: string) => data<DomainsActionData>({ ok: true, intent, message, hostname });
  try {
    switch (intent) {
      case 'add': {
        const d = await addDomain(app, form.get('hostname'), actor, process.env, {
          maxPerApp: await maxDomainsPerApp(access.workspace.id),
        });
        return done(`${d.hostname} added — create the two DNS records below, then click Verify.`, d.hostname);
      }
      case 'verify': {
        const out = await verifyDomain(app, id, actor);
        if (out.check.ok) return done(`${out.domain.hostname} is verified and serves the published version.`, out.domain.hostname);
        return data<DomainsActionData>(
          {
            ok: false,
            intent,
            code: out.check.transient ? 'dns_unavailable' : 'not_verified',
            error: `${out.domain.hostname} is not verified yet: ${out.check.error ?? 'the DNS records are missing.'}`,
            hostname: out.domain.hostname,
          },
          { status: 200 }
        );
      }
      case 'primary':
        await setPrimaryDomain(app, id, actor);
        return done('Primary domain set — the drobek address now redirects there.');
      case 'unprimary':
        await setPrimaryDomain(app, null, actor);
        return done('No primary domain — the drobek address serves the app itself.');
      case 'remove': {
        const { hostname } = await removeDomain(app, id, actor);
        return done(`${hostname} removed.`, hostname);
      }
      default:
        return data<DomainsActionData>({ ok: false, intent, code: 'bad_request', error: 'Unsupported action.' }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof DomainsError) {
      return data<DomainsActionData>({ ok: false, intent, code: err.code, error: err.message }, { status: domainsErrorStatus(err.code) });
    }
    throw err;
  }
}
