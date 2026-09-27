/**
 * The custom-domain tools (NSO-366, MCP parity with the dashboard's Domains
 * tab): list_domains, add_domain, verify_domain, set_primary_domain,
 * remove_domain. Every body calls the SAME @drobek/domains operation as the
 * dashboard (validation, DOMAINS_MAX_PER_APP from the workspace's limits,
 * DNS verification, the audit rows `domain.add` / `domain.verify` /
 * `domain.unverify` / `domain.primary` / `domain.remove` — here as the agent)
 * and addresses a domain by its hostname.
 *
 * Roles as in the dashboard: viewer+ lists, editor+ changes. Scopes:
 * list_domains read; add_domain, verify_domain and remove_domain write;
 * set_primary_domain publish — it changes where the production address
 * sends every visitor. What changes the public site needs the user's explicit
 * yes (`user_confirmed: true`): setting or clearing the primary domain, and
 * removing a VERIFIED domain (it stops serving at once). Adding and verifying
 * do not: a domain serves only after its owner created both DNS records.
 * A taken-down app (NSO-293) refuses adding, verifying and a primary; removing
 * stays possible.
 */
import { appsOrigin, publishedUrl } from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import {
  DomainsError,
  addDomain,
  cnameTarget,
  domainByHostname,
  listDomains,
  removeDomain,
  setPrimaryDomain,
  verifyDomain,
  type DomainActor,
  type DomainApp,
  type DomainView,
  type RecordStatus,
} from '@drobek/domains';
import { authorizeApp } from './access.js';
import { ToolError, lockedByAdmin } from './errors.js';
import type { AppRow } from './queries.js';
import type { CallContext } from './tools.js';

/** How long DNS changes may take to be seen, for the agent to relay. */
const DNS_PATIENCE = 'DNS changes can take from a few minutes up to 48 hours to reach every resolver';

function domainApp(app: AppRow): DomainApp {
  return { id: app.id, slug: app.slug, workspaceId: app.workspaceId };
}

function actorOf(ctx: CallContext): DomainActor {
  return { userId: ctx.principal.userId, kind: actorKindForSurface('mcp') };
}

function refuseIfLocked(app: AppRow): void {
  if (app.lockedReason) throw lockedByAdmin(app.lockedReason);
}

/** A DomainsError as the agent's ToolError (codes renamed where the bare word is ambiguous). */
function toolErrorOf(err: unknown): unknown {
  if (!(err instanceof DomainsError)) return err;
  switch (err.code) {
    case 'already_added':
      return new ToolError('domain_already_added', err.message);
    case 'not_verified':
      return new ToolError('domain_not_verified', err.message);
    case 'not_found':
      return new ToolError('not_found', err.message);
    default:
      return new ToolError(err.code, err.message, err.details);
  }
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toolErrorOf(err);
  }
}

/** The records to create, in the shape the agent shows the user. */
function recordsOf(d: DomainView) {
  return {
    cname: { type: 'CNAME', name: d.instructions.cname.name, value: d.instructions.cname.value },
    txt: { type: 'TXT', name: d.instructions.txt.name, value: d.instructions.txt.value },
  };
}

function domainOut(d: DomainView) {
  return {
    host: d.hostname,
    status: d.verified ? ('verified' as const) : ('pending' as const),
    primary: d.isPrimary,
    records: recordsOf(d),
    verified_at: d.verifiedAt?.toISOString() ?? null,
    last_check_at: d.lastCheckAt?.toISOString() ?? null,
    last_error: d.lastError,
    certificate: d.certState,
  };
}

async function maxPerApp(ctx: CallContext, app: AppRow): Promise<number> {
  return (await ctx.modules.workspaceLimits(app.workspaceId)).DOMAINS_MAX_PER_APP;
}

async function findDomain(ctx: CallContext, app: AppRow, host: unknown): Promise<DomainView> {
  if (typeof host !== 'string' || host.trim() === '') throw new ToolError('invalid_params', '`host` must be a domain name, e.g. shop.example.com.');
  const d = await domainByHostname(domainApp(app), host, ctx.deps.env);
  if (!d) throw new ToolError('not_found', `${host.trim()} is not a domain of this app — list_domains lists them.`);
  return d;
}

// ── list_domains ─────────────────────────────────────────────────────────────

export async function listDomainsTool(ctx: CallContext, args: { app_id: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  const domains = await listDomains(domainApp(app), ctx.deps.env);
  const max = await maxPerApp(ctx, app);
  return {
    app_id: app.id,
    cname_target: cnameTarget(app.slug, appsOrigin(ctx.deps.env).domain),
    max_per_app: max,
    domains: domains.map(domainOut),
    ...(max === 0 ? { note: 'Custom domains are off for this workspace (DOMAINS_MAX_PER_APP is 0).' } : {}),
  };
}

// ── add_domain ───────────────────────────────────────────────────────────────

export async function addDomainTool(ctx: CallContext, args: { app_id: string; host: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  refuseIfLocked(app);
  const max = await maxPerApp(ctx, app);
  const d = await run(() => addDomain(domainApp(app), args.host, actorOf(ctx), ctx.deps.env, { maxPerApp: max }));
  return {
    domain: domainOut(d),
    next: `Ask the user to create both DNS records at their DNS provider — CNAME ${d.instructions.cname.name} → ${d.instructions.cname.value} (an apex name: an ALIAS/ANAME or flattened CNAME to the same target) and TXT ${d.instructions.txt.name} = ${d.instructions.txt.value} — then call verify_domain. ${DNS_PATIENCE}.`,
  };
}

// ── verify_domain ────────────────────────────────────────────────────────────

const MISSING: Record<Exclude<RecordStatus, 'ok'>, string> = {
  missing: 'not found',
  wrong: 'found, but with a different value',
  unavailable: 'could not be looked up (DNS timeout or server failure)',
};

export async function verifyDomainTool(ctx: CallContext, args: { app_id: string; host: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  refuseIfLocked(app);
  const target = await findDomain(ctx, app, args.host);
  const out = await run(() => verifyDomain(domainApp(app), target.id, actorOf(ctx), { env: ctx.deps.env, resolver: ctx.deps.dns() }));
  const d = out.domain;
  if (out.check.ok) {
    return {
      domain: domainOut(d),
      newly_verified: out.newlyVerified,
      note: `${d.hostname} is verified: it serves the app's published version${app.publishedVersionId ? '' : ' once the app is published'} (the first HTTPS request may take a few seconds while the certificate is issued). set_primary_domain makes the drobek address redirect to it.`,
    };
  }
  const problems: string[] = [];
  if (out.check.target !== 'ok') problems.push(`CNAME ${d.instructions.cname.name} → ${d.instructions.cname.value}: ${MISSING[out.check.target]}`);
  if (out.check.txt !== 'ok') problems.push(`TXT ${d.instructions.txt.name} = ${d.instructions.txt.value}: ${MISSING[out.check.txt]}`);
  const details = {
    host: d.hostname,
    cname: out.check.target,
    txt: out.check.txt,
    records: recordsOf(d),
    ...(out.unverified ? { unverified: true } : {}),
  };
  if (out.check.transient) {
    throw new ToolError(
      'dns_unavailable',
      `${d.hostname} could not be checked: ${problems.join('; ')}. Nothing changed — try verify_domain again in a few minutes.`,
      details
    );
  }
  throw new ToolError(
    'domain_not_verified',
    `${d.hostname} is not verified yet — ${problems.join('; ')}.${out.unverified ? ' It was verified before and has now lost its verification: it no longer serves the app.' : ''} ${DNS_PATIENCE}; call verify_domain again once the records are in place.`,
    details
  );
}

// ── set_primary_domain ───────────────────────────────────────────────────────

export async function setPrimaryDomainTool(
  ctx: CallContext,
  args: { app_id: string; host: string | null; user_confirmed?: boolean }
) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (args.host !== null && typeof args.host !== 'string') {
    throw new ToolError('invalid_params', '`host` must be a verified domain of the app, or null to clear the primary domain.');
  }
  const production = new URL(publishedUrl(app.slug, ctx.deps.env)).host;
  let target: DomainView | null = null;
  if (args.host !== null) {
    refuseIfLocked(app);
    target = await findDomain(ctx, app, args.host);
    if (!target.verified) {
      throw new ToolError('domain_not_verified', `Verify ${target.hostname} (verify_domain) before making it primary.`, { host: target.hostname });
    }
  }
  const current = (await listDomains(domainApp(app), ctx.deps.env)).find((d) => d.isPrimary && d.verified) ?? null;
  if (args.user_confirmed !== true) {
    throw new ToolError(
      'user_confirmation_required',
      target
        ? `Making ${target.hostname} the primary domain redirects every visitor of ${production} there (302). Ask the user whether ${target.hostname} should be the app's primary address, and call again with user_confirmed: true only after they say yes.`
        : `Clearing the primary domain makes ${production} serve the app itself again${current ? ` instead of redirecting to ${current.hostname}` : ''}. Ask the user whether to clear it, and call again with user_confirmed: true only after they say yes.`,
      { host: target?.hostname ?? null, current_primary: current?.hostname ?? null }
    );
  }
  await run(() => setPrimaryDomain(domainApp(app), target?.id ?? null, actorOf(ctx)));
  return {
    app_id: app.id,
    primary: target?.hostname ?? null,
    previous_primary: current?.hostname ?? null,
    note: target
      ? `${production} now redirects (302) to ${target.hostname}.`
      : `${production} serves the app itself; the verified domains keep serving it too.`,
  };
}

// ── remove_domain ────────────────────────────────────────────────────────────

export async function removeDomainTool(ctx: CallContext, args: { app_id: string; host: string; user_confirmed?: boolean }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  const target = await findDomain(ctx, app, args.host);
  if (target.verified && args.user_confirmed !== true) {
    throw new ToolError(
      'user_confirmation_required',
      `${target.hostname} is verified and serves the app${target.isPrimary ? ' (it is the primary domain: the drobek address redirects there)' : ''}; removing it takes the app off that address at once. Ask the user whether to remove ${target.hostname}, and call again with user_confirmed: true only after they say yes.`,
      { host: target.hostname, primary: target.isPrimary }
    );
  }
  const { hostname } = await run(() => removeDomain(domainApp(app), target.id, actorOf(ctx)));
  return {
    removed: hostname,
    was_verified: target.verified,
    was_primary: target.isPrimary,
    note: 'The DNS records can be deleted now. A certificate already issued for the name expires on its own.',
  };
}
