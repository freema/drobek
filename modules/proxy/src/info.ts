/**
 * The proxy module's per-app info for the agent (get_app `modules.proxy.info`,
 * configure_module `info`): every upstream of the app's workspace and every
 * upstream the app's config names, with
 *
 *   { name, registered, assigned, call?, rateLimit?, hasSecret, allowedMethods?, allowedPathPrefixes? }
 *
 * `hasSecret` says whether the workspace admin stored the upstream's secret —
 * NEVER its value (nor the base URL: the app only ever names the upstream).
 */
import type { ModuleAppView } from '@drobek/modules';
import { upstreamSummaries } from '@drobek/proxy';
import { assignmentOf, callRuleOf, type ProxyConfig } from './config.js';

export interface UpstreamInfo {
  name: string;
  /** Registered in the app's workspace (dashboard → workspace → Upstreams). */
  registered: boolean;
  /** Named in this app's config (the app may call it, subject to `call`). */
  assigned: boolean;
  call?: string;
  rateLimit?: number;
  hasSecret: boolean;
  allowedMethods?: string[];
  allowedPathPrefixes?: string[];
}

export async function proxyAppInfo(view: ModuleAppView<ProxyConfig>): Promise<{ upstreams: UpstreamInfo[] }> {
  const registered = await upstreamSummaries(view.app.workspaceId, view.db);
  const byName = new Map(registered.map((u) => [u.name, u]));
  const names = [...new Set([...Object.keys(view.config.upstreams), ...byName.keys()])].sort();
  return {
    upstreams: names.map((name) => {
      const a = assignmentOf(view.config, name);
      const u = byName.get(name);
      const out: UpstreamInfo = { name, registered: Boolean(u), assigned: Boolean(a), hasSecret: u?.hasSecret ?? false };
      if (a) {
        out.call = callRuleOf(a);
        if (a.rateLimit) out.rateLimit = a.rateLimit;
      }
      if (u) {
        out.allowedMethods = u.allowedMethods;
        out.allowedPathPrefixes = u.allowedPathPrefixes;
      }
      return out;
    }),
  };
}
