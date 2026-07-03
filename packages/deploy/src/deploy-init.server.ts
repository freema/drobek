/**
 * deploy_init (U6, PHY-57 / PHY-100): validate the manifest + quota, create or
 * target the app, DIFF the manifest against stored blobs, and mint sha256 +
 * maxBytes-bound presigned PUT URLs for the MISSING hashes only (dedup — an
 * unchanged file gets NO upload). Writes a pending `awaiting_upload` deploy row.
 */
import { and, eq } from 'drizzle-orm';
import { mintUploadToken } from '@drobek/core';
import { apps, deploys, getDb } from '@drobek/db';
import { roleAtLeast, type WorkspaceRole } from '@drobek/tenancy';
import {
  UPLOAD_TOKEN_TTL_SEC,
  appUrl,
  publicAppUrl,
  quotaLimitsFromEnv,
} from './constants.js';
import { DeployError } from './errors.js';
import { selectMissingUploads, validateManifest } from './manifest.js';
import { deriveSlug, slugCandidate } from './slug.js';
import { presentShas } from './store.server.js';

export interface DeployInitInput {
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
  /** The caller's EFFECTIVE current role (re-checked at the tool layer). */
  role: WorkspaceRole;
  slug?: string;
  name?: string;
  manifest: unknown;
}

export interface DeployUpload {
  path: string;
  putUrl: string;
  /** unix seconds. */
  expiresAt: number;
}

export interface DeployInitResult {
  deployId: string;
  app: { workspace: string; slug: string; url: string };
  uploads: DeployUpload[];
}

function requireEditor(role: WorkspaceRole): void {
  if (!roleAtLeast(role, 'editor')) {
    throw new DeployError('forbidden', 'deploying requires an editor or workspace-admin role');
  }
}

function requireUploadSecret(): string {
  const secret = process.env.UPLOAD_SIGNING_SECRET;
  if (!secret) {
    throw new Error('UPLOAD_SIGNING_SECRET is required to mint upload tokens');
  }
  return secret;
}

/**
 * Resolve the target app slug: an explicit `slug` wins (sanitized); otherwise
 * derive from `name`. Deploying to an existing slug REUSES that app (a new
 * immutable version); a brand-new slug creates the app (uniqueness suffix on a
 * genuine collision when creating fresh).
 */
async function resolveApp(
  workspaceId: string,
  providedSlug: string | undefined,
  name: string | undefined
): Promise<{ id: string; slug: string; created: boolean }> {
  const hasSlug = typeof providedSlug === 'string' && providedSlug.trim() !== '';
  const hasName = typeof name === 'string' && name.trim() !== '';
  if (!hasSlug && !hasName) {
    throw new DeployError('invalid_manifest', 'a name or slug is required to create or target an app');
  }
  const base = deriveSlug(hasSlug ? (providedSlug as string) : (name as string));

  // Reuse an existing app with this exact slug (re-deploy → new version).
  const existing = await getDb()
    .select({ id: apps.id })
    .from(apps)
    .where(and(eq(apps.workspaceId, workspaceId), eq(apps.slug, base)))
    .limit(1);
  if (existing[0]) return { id: existing[0].id, slug: base, created: false };

  // Fresh app — find a free slug (suffix only if the base is somehow taken by
  // a concurrent create) and insert.
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = slugCandidate(base, attempt);
    const clash = await getDb()
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.workspaceId, workspaceId), eq(apps.slug, candidate)))
      .limit(1);
    if (clash[0]) continue;
    const [row] = await getDb()
      .insert(apps)
      .values({ workspaceId, slug: candidate })
      .returning({ id: apps.id });
    return { id: row.id, slug: candidate, created: true };
  }
  throw new DeployError('invalid_manifest', 'could not allocate a unique app slug');
}

export async function deployInit(input: DeployInitInput): Promise<DeployInitResult> {
  requireEditor(input.role);

  const limits = quotaLimitsFromEnv();
  const { entries, totalBytes } = validateManifest(input.manifest, limits);

  const app = await resolveApp(input.workspaceId, input.slug, input.name);

  // Dedup diff: only MISSING hashes get an upload URL.
  const present = await presentShas(entries.map((e) => e.sha256));
  const missing = selectMissingUploads(entries, present);

  // Pending deploy row (immutable manifest captured up front).
  const [deploy] = await getDb()
    .insert(deploys)
    .values({
      appId: app.id,
      manifest: entries,
      state: 'awaiting_upload',
      totalBytes,
    })
    .returning({ id: deploys.id });

  const secret = requireUploadSecret();
  const nowMs = Date.now();
  const expiresAt = Math.floor(nowMs / 1000) + UPLOAD_TOKEN_TTL_SEC;
  const base = publicAppUrl();
  const uploads: DeployUpload[] = missing.map((e) => {
    const token = mintUploadToken(
      { sha256: e.sha256, maxBytes: Math.max(1, e.bytes), ttlSec: UPLOAD_TOKEN_TTL_SEC },
      secret,
      nowMs
    );
    return { path: e.path, putUrl: `${base}/__upload/${token}`, expiresAt };
  });

  return {
    deployId: deploy.id,
    app: { workspace: input.workspaceSlug, slug: app.slug, url: appUrl(app.slug) },
    uploads,
  };
}
