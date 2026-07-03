/**
 * Orphan blob GC (PHY-100 remainder). Content-addressed blobs are shared across
 * deploys/tenants, so a blob is only safe to delete once NO blob_refs row
 * references it. The selection is pure; `sweepOrphanBlobs` drives it through an
 * injectable deps seam so it unit-tests against fakes and runs against the db +
 * BlobStore in production / the worker's periodic sweep.
 */

/** sha256s present with zero references — pure. */
export function selectOrphans(
  allShas: string[],
  referenced: ReadonlySet<string>
): string[] {
  return allShas.filter((sha) => !referenced.has(sha));
}

export interface OrphanSweepDeps {
  listAllShas(): Promise<string[]>;
  listReferencedShas(): Promise<Set<string>>;
  /** Remove BOTH the metadata row and the on-disk bytes for a blob. */
  deleteBlob(sha256: string): Promise<void>;
}

export interface OrphanSweepResult {
  scanned: number;
  deleted: string[];
}

/** Delete every unreferenced blob (metadata row + bytes); referenced blobs are untouched. */
export async function sweepOrphanBlobs(
  deps: OrphanSweepDeps
): Promise<OrphanSweepResult> {
  const [allShas, referenced] = await Promise.all([
    deps.listAllShas(),
    deps.listReferencedShas(),
  ]);
  const orphans = selectOrphans(allShas, referenced);
  for (const sha of orphans) {
    await deps.deleteBlob(sha);
  }
  return { scanned: allShas.length, deleted: orphans };
}
