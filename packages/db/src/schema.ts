/**
 * drobek core schema — day-one set (M0 walking skeleton).
 *
 * Scope per docs/TECHNICAL_DESIGN.md §1, deliberately trimmed to what P0
 * needs: identity + tenancy + apps/deploys/blobs. M1b/M2 tables
 * (sessions, oauth_*, collections, app_documents, workspace_end_users,
 * upstreams, metrics, audit_log) land with their build units — do NOT add
 * them here ahead of time.
 *
 * Hard constraints encoded here:
 * - D2: blobs are content-addressed METADATA only — bytes live on local disk
 *   via the BlobStore (P0-B). No bytea column, ever.
 * - PHY-101: soft-delete tombstones (`deleted_at`) on apps + deploys.
 * - super-admin is a GLOBAL env flag (SUPERADMIN_EMAIL), NOT a membership
 *   role — hence memberships only knows workspace-admin/editor/viewer.
 */
import { createId } from '@paralleldrive/cuid2';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Who performed an audited action (PHY-85). `agent` = an MCP tool call made on
 * behalf of a connected coding agent (OAuth token); `user` = a human dashboard/
 * web session action. Derived SERVER-SIDE at the call site — never from client
 * input — so attribution is not spoofable. Defaults to `user` so the existing
 * deploy/rollback rows migrate additively without loss.
 */
export const auditActorKindEnum = pgEnum('audit_actor_kind', ['user', 'agent']);

// ── Enums ────────────────────────────────────────────────────────────────────

export const workspaceKindEnum = pgEnum('workspace_kind', ['personal', 'team']);

export const membershipRoleEnum = pgEnum('membership_role', [
  'workspace-admin',
  'editor',
  'viewer',
]);

export const routingModeEnum = pgEnum('routing_mode', ['spa', 'exact']);

/** App visibility gate, checked BEFORE serving blobs (public | team | password). */
export const appVisibilityEnum = pgEnum('app_visibility', [
  'public',
  'team',
  'password',
]);

export const appStatusEnum = pgEnum('app_status', ['live', 'hibernated']);

/**
 * Deploy lifecycle (U6, PHY-57). The pipeline streams these to the dashboard
 * over SSE (Redis pub/sub channel `drobek:deploy:<id>`):
 *   awaiting_upload → queued → linting → storing → activating → ready
 *                                   └──────────────────────────→ failed
 * A deploy only ever serves traffic once it is `ready` AND
 * `apps.active_deploy_id` points at it.
 */
export const deployStateEnum = pgEnum('deploy_state', [
  'awaiting_upload',
  'queued',
  'linting',
  'storing',
  'activating',
  'ready',
  'failed',
]);

// ── Identity ─────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  email: text('email').notNull().unique(),
  /** Google OIDC subject (`sub`); links the OAuth account to this user (U3). */
  googleSub: text('google_sub').unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ── Tenancy ──────────────────────────────────────────────────────────────────

export const workspaces = pgTable('workspaces', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  kind: workspaceKindEnum('kind').notNull(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    role: membershipRoleEnum('role').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })]
);

// ── Apps & deploys ───────────────────────────────────────────────────────────

export const apps = pgTable(
  'apps',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    slug: text('slug').notNull(),
    /** Currently served deploy; flipping this IS the deploy/rollback primitive. */
    activeDeployId: text('active_deploy_id').references(
      (): AnyPgColumn => deploys.id
    ),
    routingMode: routingModeEnum('routing_mode').notNull().default('spa'),
    visibility: appVisibilityEnum('visibility').notNull().default('public'),
    /** Only set when visibility = 'password'. */
    passwordHash: text('password_hash'),
    status: appStatusEnum('status').notNull().default('live'),
    usesEndUserAuth: boolean('uses_end_user_auth').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    /** Soft-delete tombstone (PHY-101) — erasure vs deploy immutability. */
    deletedAt: timestamp('deleted_at'),
  },
  (t) => [uniqueIndex('apps_workspace_slug_uq').on(t.workspaceId, t.slug)]
);

/** Immutable deploy versions — rollback = repoint apps.active_deploy_id. */
export const deploys = pgTable('deploys', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  appId: text('app_id')
    .notNull()
    .references(() => apps.id),
  manifest: jsonb('manifest').notNull(),
  lintReport: jsonb('lint_report'),
  /** Pipeline state streamed to the dashboard over SSE (U6, PHY-57). */
  state: deployStateEnum('state').notNull().default('awaiting_upload'),
  /** Actionable failure summary when state = 'failed' (lint block, etc.). */
  error: text('error'),
  /** Sum of the manifest's declared bytes — per-deploy quota accounting. */
  totalBytes: bigint('total_bytes', { mode: 'number' }),
  /** When this deploy last became the active (ready + pointed-at) version. */
  activatedAt: timestamp('activated_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  /** Soft-delete tombstone (PHY-101). */
  deletedAt: timestamp('deleted_at'),
});

/**
 * Content-addressed blob METADATA. The bytes live on local disk under the
 * BlobStore (D2 — `/data/blobs/<ab>/<sha256>`, P0-B); `path` is the
 * store-relative location. NO byte content in Postgres.
 */
export const blobs = pgTable('blobs', {
  sha256: text('sha256').primaryKey(),
  contentType: text('content_type').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  path: text('path').notNull(),
});

/** Refcount join — which deploys reference which blob (cross-tenant-safe GC). */
export const blobRefs = pgTable(
  'blob_refs',
  {
    sha256: text('sha256')
      .notNull()
      .references(() => blobs.sha256),
    deployId: text('deploy_id')
      .notNull()
      .references(() => deploys.id),
  },
  (t) => [primaryKey({ columns: [t.sha256, t.deployId] })]
);

/** Deploy manifest expanded: request path → blob hash. */
export const deployFiles = pgTable(
  'deploy_files',
  {
    deployId: text('deploy_id')
      .notNull()
      .references(() => deploys.id),
    path: text('path').notNull(),
    sha256: text('sha256')
      .notNull()
      .references(() => blobs.sha256),
  },
  (t) => [primaryKey({ columns: [t.deployId, t.path] })]
);

/**
 * Append-only audit trail (U6/PHY-57; governance v1 PHY-85; TECHNICAL_DESIGN
 * §1). Every security-relevant workspace mutation (deploy.activate,
 * deploy.rollback, app.create, member.invite/accept/role_change, …) writes one
 * immutable row. APPEND-ONLY: rows are never updated and never deleted except by
 * the age-based retention prune (@drobek/audit).
 *
 * Attribution (PHY-85): `actor_user_id` is the acting user (nullable for system
 * actions); `actor_kind` records whether that action came from a connected AGENT
 * (an MCP tool call) or a human USER (dashboard/web) — both derived server-side.
 *
 * Subject: `subject_type` names the kind of thing acted on (app | member | …)
 * and `target` holds its STABLE id (the app slug, the member user id, …). It is
 * deliberately plain text with NO foreign key, so an audit row SURVIVES the
 * deletion/tombstoning of its subject app/workspace (governance must outlive the
 * resource). `meta` carries structured, secret-free, PII-free context only.
 *
 * `workspace_id` keeps the FK (audit is always read within a live workspace and
 * workspaces are not deleted in v1); the subject app id is the one that must
 * survive deletion, hence its text-not-FK treatment above.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    actorUserId: text('actor_user_id').references(() => users.id),
    /** agent (MCP tool) vs user (dashboard/web) — server-derived, not spoofable. */
    actorKind: auditActorKindEnum('actor_kind').notNull().default('user'),
    action: text('action').notNull(),
    /** The KIND of subject acted on: 'app' | 'member' | … (nullable, forward-open). */
    subjectType: text('subject_type'),
    /** The subject's stable id (app slug, member user id, …) — text, NO FK. */
    target: text('target'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    // The Activity view reads by workspace, newest-first — index it.
    index('audit_log_workspace_created_idx').on(t.workspaceId, t.createdAt),
  ]
);

// ── Data API v1 — jsonb collections + documents (U10, PHY-55/PHY-56) ──────────
//
// A hosted app owns any number of named collections; each carries a REQUIRED
// JSON Schema (validated server-side on every write) and a per-collection
// ACCESS MODE that gates the REST data endpoints:
//   public-read   — anon may read; writes require an editor+ member.
//   public-write  — anon may read AND write (schema still enforced).
//   locked        — no anon access; read/write only for workspace members
//                   (viewer reads, editor writes) or the authed MCP author.
//   owner-only    — reserved for U11 hosted-app END-USER auth (each end user
//                   sees only their own docs). Defined here for forward-compat;
//                   U10 rejects record ops on such collections as not_implemented.
// `owner_end_user_id` is likewise a forward-compat nullable column (always null
// in U10 — the workspace_end_users table lands with end-user auth in U11).
export const collectionAccessModeEnum = pgEnum('collection_access_mode', [
  'public-read',
  'public-write',
  'locked',
  'owner-only',
]);

export const collections = pgTable(
  'collections',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id),
    name: text('name').notNull(),
    /** REQUIRED JSON Schema; every write is validated against this (ajv). */
    jsonSchema: jsonb('json_schema').notNull(),
    accessMode: collectionAccessModeEnum('access_mode')
      .notNull()
      .default('locked'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('collections_app_name_uq').on(t.appId, t.name)]
);

/**
 * Per-app JSON documents (U10, PHY-55). `collection` is the collection NAME
 * (unique per app in `collections`); `doc` is the validated payload.
 * Soft-delete tombstone `deleted_at` (PHY-101) — a deleted doc is excluded from
 * every read/query but the row is retained.
 */
export const appDocuments = pgTable(
  'app_documents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id),
    collection: text('collection').notNull(),
    /** Forward-compat (U11 end-user auth) — always null in U10. */
    ownerEndUserId: text('owner_end_user_id'),
    doc: jsonb('doc').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    /** Soft-delete tombstone (PHY-101). */
    deletedAt: timestamp('deleted_at'),
  },
  (t) => [index('app_documents_app_collection_idx').on(t.appId, t.collection)]
);

// ── MCP OAuth 2.1 Authorization Server (U5, PHY-71/PHY-53) ────────────────────
//
// drobek's web app is the OAuth 2.1 Authorization Server; mcp-server is the
// protected Resource Server. All opaque tokens/codes are stored SHA-256-hashed
// at rest (never the raw secret). PKCE S256 is mandatory. Tokens are
// USER-scoped and carry a chosen workspace + membership role + an RFC 8707
// `audience` the Resource Server validates. See @drobek/oauth.

/** Dynamically registered (DCR) public PKCE clients — no client_secret. */
export const oauthClients = pgTable('oauth_clients', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  clientId: text('client_id').notNull().unique(),
  clientName: text('client_name').notNull(),
  /** Exact-match set — the authorize redirect_uri must equal one of these. */
  redirectUris: text('redirect_uris').array().notNull(),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method')
    .notNull()
    .default('none'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** Single-use PKCE authorization codes (~5 min TTL); consumed atomically. */
export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  codeHash: text('code_hash').notNull().unique(),
  /** Public client_id string the code was issued to (FK → oauth_clients). */
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  role: membershipRoleEnum('role').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull(),
  scope: text('scope').notNull(),
  /** RFC 8707 requested resource → becomes the access token audience. */
  resource: text('resource').notNull(),
  used: boolean('used').notNull().default(false),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** Opaque access tokens (~1 h TTL), audience-bound (RFC 8707). */
export const oauthAccessTokens = pgTable('oauth_access_tokens', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  tokenHash: text('token_hash').notNull().unique(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  role: membershipRoleEnum('role').notNull(),
  oauthClientId: text('oauth_client_id').references(() => oauthClients.id, {
    onDelete: 'set null',
  }),
  scope: text('scope').notNull(),
  audience: text('audience').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  revokedAt: timestamp('revoked_at'),
});

/**
 * Opaque refresh tokens (~30 day TTL) with ROTATION + reuse detection. On use:
 * `used_at` is stamped and `rotated_to` points at the freshly-issued successor.
 * Presenting a token whose `used_at` is already set is REUSE → the whole
 * rotated_to lineage is invalidated and the grant's access tokens revoked.
 */
export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  tokenHash: text('token_hash').notNull().unique(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  role: membershipRoleEnum('role').notNull(),
  oauthClientId: text('oauth_client_id').references(() => oauthClients.id, {
    onDelete: 'set null',
  }),
  scope: text('scope').notNull(),
  audience: text('audience').notNull(),
  /** Self-FK: the successor token minted when this one was rotated. */
  rotatedTo: text('rotated_to').references(
    (): AnyPgColumn => oauthRefreshTokens.id
  ),
  usedAt: timestamp('used_at'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ── Agent loop v1 — error beacon + serving signals (PHY-123, PHY-92 slice) ─────
//
// The observe half of the deploy→observe→fix loop. `app_errors` is a per-app
// RING BUFFER (capped count + age, oldest evicted by @drobek/insights on insert)
// of SANITIZED client errors ingested by the PUBLIC, UNAUTHENTICATED beacon —
// only message/stack/url/ua are stored, PII/secret-redacted + truncated; NEVER
// cookies/tokens. `app_daily_stats` is the durable per-app/day serving-signal
// roll-up (request volume / 5xx / 404s-by-path), fed from Redis hot counters by
// a light flush. Both are read-only to the app_errors/app_logs MCP tools + the
// dashboard Overview panels (viewer+; stored text is escaped on render).

export const appErrorTypeEnum = pgEnum('app_error_type', [
  'error',
  'unhandledrejection',
]);

export const appErrors = pgTable(
  'app_errors',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id),
    type: appErrorTypeEnum('type').notNull(),
    /** Sanitized (redacted + truncated) error message. */
    message: text('message').notNull(),
    /** Sanitized stack, when the browser supplied one. */
    stack: text('stack'),
    /** Page URL the error fired on (sanitized). */
    url: text('url').notNull(),
    /** User-agent (sanitized), when present. */
    ua: text('ua'),
    /** Client-supplied event time (validated epoch-ms → timestamp); may skew. */
    ts: timestamp('ts'),
    /** sha256(message + stack head) — groups identical errors with counts. */
    dedupKey: text('dedup_key').notNull(),
    /** Server ingest time — the authoritative ordering + retention field. */
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('app_errors_app_created_idx').on(t.appId, t.createdAt)]
);

/**
 * Per-app, per-UTC-day serving signals (PHY-123). `day` is a `YYYY-MM-DD` string
 * (deterministic bucket, no tz math). `path_404_counts` is `{ path: count }`;
 * `__other__` absorbs paths past the per-day cardinality cap. Upserted from the
 * Redis hot counters on the read path (unique on (app_id, day)).
 */
export const appDailyStats = pgTable(
  'app_daily_stats',
  {
    appId: text('app_id')
      .notNull()
      .references(() => apps.id),
    day: text('day').notNull(),
    path404Counts: jsonb('path_404_counts')
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    count5xx: integer('count_5xx').notNull().default(0),
    requestCount: integer('request_count').notNull().default(0),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.day] })]
);
