/**
 * Upstream CRUD (PHY-59). Registration is workspace-admin+ only (super-admin
 * override); every mutation writes an audit row. The injected secret is
 * envelope-encrypted at rest and is NEVER returned by any function here — the
 * safe view exposes only `hasSecret`.
 */
import { and, eq } from 'drizzle-orm';
import { actorKindForSurface, writeAudit } from '@drobek/audit';
import { getDb, upstreamSecrets, upstreams } from '@drobek/db';
import type { WorkspaceRole } from '@drobek/tenancy';
import { PROXY_AUDIT_ACTIONS, PROXY_SUBJECT_TYPE } from './audit-actions.js';
import { canConfigureUpstreams } from './authz.js';
import { encryptSecret, type SecretEnvelope } from './crypto.server.js';
import { ProxyError } from './errors.js';
import type { UpstreamAuthType } from './auth-inject.js';
import {
  normalizeMethods,
  normalizePrefixes,
  validateBaseUrl,
} from './validate.js';

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/i;

/** Safe, secret-free upstream view (dashboard/API). */
export interface UpstreamView {
  id: string;
  name: string;
  baseUrl: string;
  allowedMethods: string[];
  allowedPathPrefixes: string[];
  authType: UpstreamAuthType;
  authHeaderName: string | null;
  allowedAppIds: string[];
  hasSecret: boolean;
  createdAt: string;
}

/** Full row incl. the persisted secret envelope — INTERNAL to the forward path. */
export interface UpstreamRecord {
  id: string;
  workspaceId: string;
  name: string;
  baseUrl: string;
  allowedMethods: string[];
  allowedPathPrefixes: string[];
  authType: UpstreamAuthType;
  authHeaderName: string | null;
  allowedAppIds: string[];
  secret: SecretEnvelope | null;
}

export interface ConfigureActor {
  workspaceId: string;
  actorUserId: string;
  role: WorkspaceRole | null;
  superAdmin?: boolean;
}

export interface CreateUpstreamInput extends ConfigureActor {
  name: string;
  baseUrl: string;
  allowedMethods: string[];
  allowedPathPrefixes: string[];
  authType: string;
  authHeaderName?: string | null;
  allowedAppIds?: string[];
  /** Plaintext secret — encrypted here, never persisted or returned in the clear. */
  secret?: string | null;
}

function assertConfigure(actor: ConfigureActor): void {
  if (!canConfigureUpstreams(actor.role, actor.superAdmin ?? false)) {
    throw new ProxyError('forbidden', 'only workspace admins may configure upstreams');
  }
}

function isAuthType(v: string): v is UpstreamAuthType {
  return v === 'none' || v === 'bearer' || v === 'header';
}

function toView(row: typeof upstreams.$inferSelect, hasSecret: boolean): UpstreamView {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    allowedMethods: row.allowedMethods,
    allowedPathPrefixes: row.allowedPathPrefixes,
    authType: row.authType as UpstreamAuthType,
    authHeaderName: row.authHeaderName,
    allowedAppIds: row.allowedAppIds,
    hasSecret,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Register a new upstream (workspace-admin+). Encrypts the secret in-txn. */
export async function createUpstream(
  input: CreateUpstreamInput
): Promise<UpstreamView> {
  assertConfigure(input);

  const name = String(input.name ?? '').trim();
  if (!NAME_RE.test(name)) {
    throw new ProxyError(
      'invalid_request',
      'name must be 1–64 chars, start with a letter, and contain only letters, digits, "-" or "_"'
    );
  }
  const { normalized: baseUrl } = validateBaseUrl(input.baseUrl);
  const allowedMethods = normalizeMethods(input.allowedMethods);
  const allowedPathPrefixes = normalizePrefixes(input.allowedPathPrefixes);

  if (!isAuthType(input.authType)) {
    throw new ProxyError('invalid_request', 'authType must be none, bearer or header');
  }
  const authType = input.authType;
  let authHeaderName: string | null = null;
  const secretPlain = (input.secret ?? '').trim();

  if (authType === 'none') {
    if (secretPlain !== '') {
      throw new ProxyError('invalid_request', 'authType none takes no secret');
    }
  } else {
    if (secretPlain === '') {
      throw new ProxyError('invalid_request', 'a secret is required for this auth type');
    }
    if (authType === 'header') {
      authHeaderName = String(input.authHeaderName ?? '').trim();
      if (!/^[A-Za-z0-9-]{1,64}$/.test(authHeaderName)) {
        throw new ProxyError('invalid_request', 'authHeaderName must be a valid header token');
      }
    }
  }

  const envelope = secretPlain !== '' ? encryptSecret(secretPlain) : null;

  const db = getDb();
  const existing = await db
    .select({ id: upstreams.id })
    .from(upstreams)
    .where(and(eq(upstreams.workspaceId, input.workspaceId), eq(upstreams.name, name)))
    .limit(1);
  if (existing[0]) {
    throw new ProxyError('invalid_request', `an upstream named "${name}" already exists`);
  }

  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(upstreams)
      .values({
        workspaceId: input.workspaceId,
        name,
        baseUrl,
        allowedMethods,
        allowedPathPrefixes,
        authType,
        authHeaderName,
        allowedAppIds: input.allowedAppIds ?? [],
        createdBy: input.actorUserId,
      })
      .returning();

    if (envelope) {
      await tx.insert(upstreamSecrets).values({
        upstreamId: created.id,
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        authTag: envelope.authTag,
        wrappedDek: envelope.wrappedDek,
        kekId: envelope.kekId,
      });
    }

    await writeAudit(
      {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        actorKind: actorKindForSurface('web'),
        action: PROXY_AUDIT_ACTIONS.upstreamCreate,
        subjectType: PROXY_SUBJECT_TYPE,
        target: created.id,
        // Secret-free context only.
        meta: {
          name,
          authType,
          methods: allowedMethods,
          pathPrefixes: allowedPathPrefixes,
        },
      },
      tx
    );

    return created;
  });

  return toView(row, envelope !== null);
}

/** List a workspace's upstreams (workspace-admin+) — secret-free views. */
export async function listUpstreams(actor: ConfigureActor): Promise<UpstreamView[]> {
  assertConfigure(actor);
  const rows = await getDb()
    .select()
    .from(upstreams)
    .where(eq(upstreams.workspaceId, actor.workspaceId))
    .orderBy(upstreams.name);

  if (rows.length === 0) return [];
  const withSecret = new Set(
    (
      await getDb()
        .select({ upstreamId: upstreamSecrets.upstreamId })
        .from(upstreamSecrets)
    ).map((r) => r.upstreamId)
  );
  return rows.map((r) => toView(r, withSecret.has(r.id)));
}

/** Get one upstream by name (workspace-admin+) — secret-free view or null. */
export async function getUpstream(
  actor: ConfigureActor,
  name: string
): Promise<UpstreamView | null> {
  assertConfigure(actor);
  const rows = await getDb()
    .select()
    .from(upstreams)
    .where(and(eq(upstreams.workspaceId, actor.workspaceId), eq(upstreams.name, name)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const sec = await getDb()
    .select({ upstreamId: upstreamSecrets.upstreamId })
    .from(upstreamSecrets)
    .where(eq(upstreamSecrets.upstreamId, row.id))
    .limit(1);
  return toView(row, sec.length > 0);
}

/** Delete an upstream by id (workspace-admin+). Cascade removes its secret. */
export async function deleteUpstream(
  actor: ConfigureActor,
  upstreamId: string
): Promise<void> {
  assertConfigure(actor);
  const db = getDb();
  const rows = await db
    .select()
    .from(upstreams)
    .where(and(eq(upstreams.id, upstreamId), eq(upstreams.workspaceId, actor.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new ProxyError('not_found', 'upstream not found');
  }
  await db.transaction(async (tx) => {
    await tx.delete(upstreams).where(eq(upstreams.id, upstreamId));
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorUserId: actor.actorUserId,
        actorKind: actorKindForSurface('web'),
        action: PROXY_AUDIT_ACTIONS.upstreamDelete,
        subjectType: PROXY_SUBJECT_TYPE,
        target: row.id,
        meta: { name: row.name },
      },
      tx
    );
  });
}

/**
 * Resolve an upstream by (workspaceId, name) for the FORWARD path — includes the
 * persisted secret envelope for an in-memory decrypt. NOT role-gated here: the
 * caller's workspace membership is authorized upstream by the route.
 */
export async function resolveUpstreamForForward(
  workspaceId: string,
  name: string
): Promise<UpstreamRecord> {
  const rows = await getDb()
    .select()
    .from(upstreams)
    .where(and(eq(upstreams.workspaceId, workspaceId), eq(upstreams.name, name)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new ProxyError('not_found', 'upstream not found');
  }
  const secRows = await getDb()
    .select()
    .from(upstreamSecrets)
    .where(eq(upstreamSecrets.upstreamId, row.id))
    .limit(1);
  const sec = secRows[0];
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    baseUrl: row.baseUrl,
    allowedMethods: row.allowedMethods,
    allowedPathPrefixes: row.allowedPathPrefixes,
    authType: row.authType as UpstreamAuthType,
    authHeaderName: row.authHeaderName,
    allowedAppIds: row.allowedAppIds,
    secret: sec
      ? {
          ciphertext: sec.ciphertext,
          iv: sec.iv,
          authTag: sec.authTag,
          wrappedDek: sec.wrappedDek,
          kekId: sec.kekId,
        }
      : null,
  };
}
