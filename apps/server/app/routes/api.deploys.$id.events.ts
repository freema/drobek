/**
 * Deploy progress SSE — `GET /api/deploys/:id/events` (U6, PHY-57).
 *
 * Streams `text/event-stream` progress for one deploy by subscribing to the
 * worker's redis pub/sub channel. Auth is the dashboard session (drobek_session)
 * — the caller must be a member of the deploy's workspace (super-admin override).
 * Sends the current state immediately and closes on a terminal state. The
 * dashboard consumes this in U8; U6 ships + tests the endpoint.
 *
 * Heavy logic lives in `@drobek/deploy/events` (a react-free subpath that pulls
 * NO bullmq into the web bundle); this route is a thin session/membership gate.
 */
import type { LoaderFunctionArgs } from 'react-router';
import { getSessionUser, isSuperAdmin } from '@drobek/auth';
import { getMembership } from '@drobek/tenancy';
import {
  createDeployEventStream,
  loadDeployView,
  progressFromView,
} from '@drobek/deploy/events';

export async function loader({
  request,
  params,
}: LoaderFunctionArgs): Promise<Response> {
  const user = await getSessionUser(request);
  if (!user) {
    return new Response('unauthorized', { status: 401 });
  }

  const deployId = params.id ?? '';
  const view = await loadDeployView(deployId);
  if (!view) {
    return new Response('not found', { status: 404 });
  }

  // Membership gate (anti-enumeration: non-members get 404, not 403).
  if (!isSuperAdmin(user.email)) {
    const membership = await getMembership(user.id, view.workspaceId);
    if (!membership) {
      return new Response('not found', { status: 404 });
    }
  }

  const stream = createDeployEventStream(deployId, progressFromView(view));
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering so events flush immediately.
      'X-Accel-Buffering': 'no',
    },
  });
}
