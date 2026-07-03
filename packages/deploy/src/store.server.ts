/**
 * Blob-store + shared db-row loaders for the deploy pipeline. The store is the
 * SAME LocalDiskBlobStore the upload sink writes to (shared drobek_blobs
 * volume) — the worker reads deployed bytes back from it for the lint gate.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { createBlobStoreFromEnv, type BlobStore } from '@drobek/core';
import { apps, blobs, deploys, getDb } from '@drobek/db';
import type { ManifestEntry } from './manifest.js';
import type { DeployState } from './types.js';

let store: BlobStore | null = null;
export function getBlobStore(): BlobStore {
  store ??= createBlobStoreFromEnv();
  return store;
}

/** For tests: swap in a fake store. */
export function setBlobStoreForTests(s: BlobStore | null): void {
  store = s;
}

export interface DeployRow {
  id: string;
  appId: string;
  state: DeployState;
  manifest: ManifestEntry[];
}

export async function loadDeployRow(deployId: string): Promise<DeployRow | null> {
  const rows = await getDb()
    .select({
      id: deploys.id,
      appId: deploys.appId,
      state: deploys.state,
      manifest: deploys.manifest,
    })
    .from(deploys)
    .where(eq(deploys.id, deployId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    appId: r.appId,
    state: r.state as DeployState,
    manifest: (r.manifest as ManifestEntry[]) ?? [],
  };
}

export interface AppRow {
  id: string;
  workspaceId: string;
  slug: string;
  activeDeployId: string | null;
}

export async function loadAppRow(appId: string): Promise<AppRow | null> {
  const rows = await getDb()
    .select({
      id: apps.id,
      workspaceId: apps.workspaceId,
      slug: apps.slug,
      activeDeployId: apps.activeDeployId,
    })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadAppBySlug(
  workspaceId: string,
  slug: string
): Promise<AppRow | null> {
  const rows = await getDb()
    .select({
      id: apps.id,
      workspaceId: apps.workspaceId,
      slug: apps.slug,
      activeDeployId: apps.activeDeployId,
    })
    .from(apps)
    .where(
      and(eq(apps.workspaceId, workspaceId), eq(apps.slug, slug), isNull(apps.deletedAt))
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Which of the given sha256s already have a stored blob metadata row. */
export async function presentShas(shas: string[]): Promise<Set<string>> {
  const unique = [...new Set(shas)];
  if (unique.length === 0) return new Set();
  const rows = await getDb()
    .select({ sha256: blobs.sha256 })
    .from(blobs)
    .where(inArray(blobs.sha256, unique));
  return new Set(rows.map((r) => r.sha256));
}
