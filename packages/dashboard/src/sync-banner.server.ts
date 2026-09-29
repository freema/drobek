/**
 * The data behind the "a scheduled import stopped" banner (NSO-392): the
 * sources of the module that declares `sync` (followed by capability, never
 * by name) that paused after failed runs. Best effort — a failure hides the
 * banner, it never breaks the page that renders it.
 */
import { moduleRuntime } from '@drobek/modules';
import type { SyncBannerData } from './sync-banner.js';

export async function loadSyncBanner(app: { id: string; slug: string; workspaceId: string }, workspaceSlug: string): Promise<SyncBannerData | null> {
  try {
    const runtime = await moduleRuntime();
    const sync = await runtime.sync(app);
    if (!sync || !(await runtime.isEnabled(app.workspaceId, sync.module))) return null;
    const paused = (await sync.sources())
      .filter((s) => s.paused === 'failures')
      .map((s) => ({ name: s.name, failures: s.failures, error: s.last_error }));
    if (paused.length === 0) return null;
    return {
      paused,
      href: `/workspaces/${encodeURIComponent(workspaceSlug)}/apps/${encodeURIComponent(app.slug)}/modules/${encodeURIComponent(sync.module)}#sync`,
    };
  } catch {
    return null;
  }
}
