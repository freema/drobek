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
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

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
