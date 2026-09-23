/**
 * M1b Agent DX (PHY-124) — `GET /llms-full.txt`: the full delivery-stack
 * contract (MCP connect/OAuth flow, every tool with its input schema + example,
 * the REST Data API, the deploy flow, the serving model, quotas/limits, and the
 * error catalogue). Rendered from the @drobek/agent-dx manifest. text/plain,
 * cacheable.
 */
import { renderLlmsFull } from '@drobek/agent-dx';

export function loader(): Response {
  return new Response(renderLlmsFull(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
