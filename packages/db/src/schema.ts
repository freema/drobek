/**
 * drobek core schema — day-one set (M0 walking skeleton).
 *
 * Identity + tenancy + apps and their immutable versions (M0-02, NSO-281),
 * plus the tables each later unit added (oauth_*, collections, app_documents,
 * upstreams, audit_log, app_errors, app_daily_stats).
 *
 * Hard constraints encoded here:
 * - App file bytes live IN Postgres (`blobs.bytes`, content-addressed by
 *   sha256, deduplicated across versions and apps). Apps are small source
 *   trees (≤ 5 MiB per version, enforced by @drobek/compile), so one database
 *   is the whole state — no disk volume to back up separately.
 * - A version is immutable; publish/restore only move `apps.published_version_id`
 *   or add a new version.
 * - PHY-101: soft-delete tombstone (`deleted_at`) on apps.
 * - super-admin is a GLOBAL env flag (SUPERADMIN_EMAIL), NOT a membership
 *   role — hence memberships only knows workspace-admin/editor/viewer.
 */
import { createId } from '@paralleldrive/cuid2';
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
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
import { sql } from 'drizzle-orm';

/** Postgres `bytea` ↔ Node `Buffer`. */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)),
});

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

/** App visibility gate, checked BEFORE serving blobs (public | team | password). */
export const appVisibilityEnum = pgEnum('app_visibility', [
  'public',
  'team',
  'password',
]);

export const appStatusEnum = pgEnum('app_status', ['live', 'hibernated']);

/**
 * Result of compiling a version (@drobek/compile). `pending` = stored but not
 * compiled yet; only an `ok` version can be published.
 */
export const compileStatusEnum = pgEnum('compile_status', ['pending', 'ok', 'error']);

/** `source` = written by the agent; `built` = compiler output (served first). */
export const versionFileKindEnum = pgEnum('version_file_kind', ['source', 'built']);

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

// ── Apps & versions ──────────────────────────────────────────────────────────

export const apps = pgTable(
  'apps',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** GLOBALLY unique — it is the app's host label `<slug>.<APPS_DOMAIN>`. */
    slug: text('slug').notNull(),
    /** Human-readable name given at create_app (null for pre-M0-05 apps → show the slug). */
    name: text('name'),
    /** The version served on the production host; publish/rollback move it. */
    publishedVersionId: text('published_version_id').references(
      (): AnyPgColumn => appVersions.id,
      { onDelete: 'set null' }
    ),
    visibility: appVisibilityEnum('visibility').notNull().default('public'),
    /** Only set when visibility = 'password'. */
    passwordHash: text('password_hash'),
    status: appStatusEnum('status').notNull().default('live'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    /** Soft-delete tombstone (PHY-101). */
    deletedAt: timestamp('deleted_at'),
  },
  (t) => [
    uniqueIndex('apps_slug_uq').on(t.slug),
    index('apps_workspace_idx').on(t.workspaceId),
    // Grammar mirrored by @drobek/apps validateAppSlug (which adds reserved words).
    check(
      'apps_slug_format',
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${t.slug}) BETWEEN 3 AND 40`
    ),
  ]
);

/** Content-addressed file bytes, shared by every version (and app) that uses them. */
export const blobs = pgTable('blobs', {
  sha256: text('sha256').primaryKey(),
  bytes: bytea('bytes').notNull(),
  size: integer('size').notNull(),
  /** Refreshed whenever a new version references the blob (GC grace period). */
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** One immutable snapshot of an app's files; `number` counts up per app from 1. */
export const appVersions = pgTable(
  'app_versions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id),
    number: integer('number').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    /** agent (MCP) vs user (dashboard) — server-derived, like audit_log. */
    actorKind: auditActorKindEnum('actor_kind').notNull(),
    /** The agent's one-line "why" for this change (shown in the history). */
    reasoning: text('reasoning'),
    compileStatus: compileStatusEnum('compile_status').notNull().default('pending'),
    /** @drobek/compile messages when compile_status = 'error'. */
    compileErrors: jsonb('compile_errors'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('app_versions_app_number_uq').on(t.appId, t.number)]
);

/** A version's file list: path → blob. A path may exist once per kind. */
export const versionFiles = pgTable(
  'version_files',
  {
    versionId: text('version_id')
      .notNull()
      .references(() => appVersions.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    sha256: text('sha256')
      .notNull()
      .references(() => blobs.sha256),
    size: integer('size').notNull(),
    kind: versionFileKindEnum('kind').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.kind, t.path] }),
    index('version_files_sha256_idx').on(t.sha256),
  ]
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
// bound to a USER (M0-04, NSO-282) — not to a workspace: every MCP tool call
// re-resolves the caller's membership in the workspace it targets — and carry
// the granted scope (`read` / `write` / `publish`) plus the RFC 8707
// `audience` the Resource Server validates. See @drobek/oauth.

/**
 * Public PKCE clients — no client_secret. `source` = `dcr` for a Dynamic Client
 * Registration row (random hex client_id) or `cimd` for a Client ID Metadata
 * Document client (client_id = the https URL of its metadata; the row is an
 * upserted mirror of the fetched document so codes/tokens can reference it).
 * `last_used_at` is stamped when the user approves a grant for the client —
 * a DCR row that never got one counts toward the unused-client cap.
 */
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
  source: text('source').notNull().default('dcr'),
  lastUsedAt: timestamp('last_used_at'),
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

/**
 * Personal API keys (M0-04, NSO-282): `drk_` + 32 base64url chars, an
 * alternative Bearer for the same MCP Resource Server path (the prefix tells
 * them apart). Bound to a user like an OAuth token, same scope vocabulary
 * (`scopes` is space-delimited), no audience. Only the SHA-256 of the key is
 * stored; the raw key is shown once at creation. `last_used_at` is refreshed
 * at most once a minute; a set `revoked_at` rejects the key.
 */
export const apiKeys = pgTable('api_keys', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  scopes: text('scopes').notNull(),
  lastUsedAt: timestamp('last_used_at'),
  revokedAt: timestamp('revoked_at'),
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

// ── BFF proxy v1 — authed-member gateway to a backend (PHY-59, U12 slice) ──────
//
// A static app reaches a backend WITHOUT holding its secret: drobek is the
// controlled gateway. A workspace-admin REGISTERS an upstream (a pinned base_url
// + an allow-list of methods and path prefixes + an auth mode) and stores the
// upstream secret AES-256-GCM envelope-encrypted (a random per-secret DEK wrapped
// by the KEK env DROBEK_MASTER_KEY). At forward time drobek decrypts the secret
// IN-MEMORY, injects it as the configured auth header, and forwards to the
// SSRF-guarded upstream. In v1 the caller is an AUTHENTICATED workspace MEMBER
// (drobek_session) — the anonymous public-app-visitor path is DEFERRED to U11
// end-user auth (Referer is spoofable and is NOT a caller-auth boundary), so
// `allowed_app_ids` is STORED for U11 but is NOT the v1 caller-auth.

/** MVP upstream auth modes. HMAC + OpenAPI validation are deferred (PHY-59 v1). */
export const upstreamAuthTypeEnum = pgEnum('upstream_auth_type', [
  'none',
  'bearer',
  'header',
]);

export const upstreams = pgTable(
  'upstreams',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** PINNED origin+base path; validated http(s) + non-private at registration. */
    baseUrl: text('base_url').notNull(),
    /** Allow-list — a forwarded method MUST be one of these (else 405). */
    allowedMethods: text('allowed_methods').array().notNull(),
    /** Allow-list — the normalized subpath MUST start with one of these (else 403). */
    allowedPathPrefixes: text('allowed_path_prefixes').array().notNull(),
    authType: upstreamAuthTypeEnum('auth_type').notNull().default('none'),
    /** Header name to inject the secret under when auth_type = 'header'. */
    authHeaderName: text('auth_header_name'),
    /**
     * STORED for U11 hosted-app end-user auth (which app may call this upstream
     * anonymously) — NOT the v1 caller-auth (v1 = an authed workspace member).
     */
    allowedAppIds: text('allowed_app_ids').array().notNull().default([]),
    createdBy: text('created_by').references(() => users.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('upstreams_workspace_name_uq').on(t.workspaceId, t.name)]
);

/**
 * The upstream's injected secret, AES-256-GCM ENVELOPE-encrypted. A random
 * per-secret DEK encrypts the secret; the DEK is WRAPPED by the KEK
 * (DROBEK_MASTER_KEY). `kek_id` records which KEK wrapped it (enables rotation +
 * fails closed on a wrong/rotated key — the GCM auth tag verify fails → config
 * error, never a leak). The plaintext is NEVER stored, logged, or returned.
 */
export const upstreamSecrets = pgTable('upstream_secrets', {
  upstreamId: text('upstream_id')
    .primaryKey()
    .references(() => upstreams.id, { onDelete: 'cascade' }),
  /** base64 AES-256-GCM ciphertext of the secret (under the DEK). */
  ciphertext: text('ciphertext').notNull(),
  /** base64 12-byte IV for the secret ciphertext. */
  iv: text('iv').notNull(),
  /** base64 GCM auth tag for the secret ciphertext. */
  authTag: text('auth_tag').notNull(),
  /** The DEK wrapped by the KEK: base64(iv).base64(tag).base64(wrappedDek). */
  wrappedDek: text('wrapped_dek').notNull(),
  /** Stable, non-secret id of the KEK that wrapped the DEK (rotation). */
  kekId: text('kek_id').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
