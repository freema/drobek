/**
 * The count behind the app header's "N changes await confirmation" banner
 * (M2-02, NSO-291): every pending platform-module change of one app (active
 * modules only). Best effort — a failure hides the banner, it never breaks the
 * page that renders it.
 */
import { moduleRuntime } from '@drobek/modules';
import type { PendingBannerData } from './pending-banner.js';

export async function loadPendingBanner(app: { id: string }, workspaceSlug: string, appSlug: string): Promise<PendingBannerData> {
  const base = `/workspaces/${encodeURIComponent(workspaceSlug)}/apps/${encodeURIComponent(appSlug)}/modules`;
  try {
    const waiting = await (await moduleRuntime()).pendingSummary(app.id);
    const count = waiting.reduce((n, w) => n + w.changes.length, 0);
    const modules = waiting.map((w) => w.module);
    return { count, modules, href: modules.length === 1 ? `${base}/${encodeURIComponent(modules[0])}` : base };
  } catch {
    return { count: 0, modules: [], href: base };
  }
}
