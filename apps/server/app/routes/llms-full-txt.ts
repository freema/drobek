/**
 * M1b Agent DX (PHY-124) — `GET /llms-full.txt`: the full delivery-stack
 * contract (MCP connect/OAuth flow, every tool with its input schema + example,
 * data access modes, quotas/limits, and the error catalogue — the core codes
 * plus one section per active platform module, NSO-344). Rendered from the
 * @drobek/agent-dx manifest. text/plain, cacheable.
 */
import { renderLlmsFull } from '@drobek/agent-dx';
import { moduleRuntime } from '@drobek/modules';

export async function loader(): Promise<Response> {
  // The server entry loads the runtime at boot (a bad DROBEK_MODULES stops the
  // start), so this only misses in tooling: then the core catalogue alone.
  const modules = await moduleRuntime()
    .then((rt) => rt.errorCatalogue())
    .catch(() => []);
  return new Response(renderLlmsFull(process.env, modules), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
