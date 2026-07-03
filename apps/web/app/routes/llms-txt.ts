/**
 * M1b Agent DX (PHY-124) — `GET /llms.txt`: the concise /llms.txt index (title +
 * summary + sectioned links). Rendered from the @drobek/agent-dx manifest so it
 * never drifts from the real tools. Served text/plain, cacheable.
 */
import { renderLlmsTxt } from '@drobek/agent-dx';

export function loader(): Response {
  return new Response(renderLlmsTxt(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
