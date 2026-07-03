/**
 * Deploy read-view + SSE stream (U6, PHY-57). This is the react-free subpath
 * the web app imports for its `/api/deploys/:id/events` route — it imports NO
 * bullmq, so the web SSR bundle never pulls the queue runtime.
 *
 * `createDeployEventStream` opens a DEDICATED redis subscriber (a duplicate of
 * the shared client — a subscribed connection cannot issue normal commands),
 * emits the current state immediately, relays each worker publish, and closes
 * on a terminal state or client disconnect.
 */
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getRedis } from '@drobek/core';
import { apps, deploys, getDb, workspaces } from '@drobek/db';
import { appUrl, deployChannel } from './constants.js';
import type { DeployProgress } from './progress.server.js';
import { isTerminalState, type DeployState } from './types.js';

export { deployChannel } from './constants.js';
export type { DeployProgress } from './progress.server.js';

export interface DeployView {
  deployId: string;
  appId: string;
  workspaceId: string;
  /** Workspace slug — needed to build the `/:ws/app/:slug` serving URL (U7). */
  workspaceSlug: string;
  appSlug: string;
  state: DeployState;
  /** True when apps.active_deploy_id points at THIS deploy. */
  active: boolean;
  lintReport: unknown | null;
  error: string | null;
}

export async function loadDeployView(deployId: string): Promise<DeployView | null> {
  const rows = await getDb()
    .select({
      deployId: deploys.id,
      appId: apps.id,
      workspaceId: apps.workspaceId,
      workspaceSlug: workspaces.slug,
      appSlug: apps.slug,
      state: deploys.state,
      activeDeployId: apps.activeDeployId,
      lintReport: deploys.lintReport,
      error: deploys.error,
    })
    .from(deploys)
    .innerJoin(apps, eq(apps.id, deploys.appId))
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(eq(deploys.id, deployId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    deployId: r.deployId,
    appId: r.appId,
    workspaceId: r.workspaceId,
    workspaceSlug: r.workspaceSlug,
    appSlug: r.appSlug,
    state: r.state as DeployState,
    active: r.activeDeployId === r.deployId,
    lintReport: r.lintReport,
    error: r.error,
  };
}

/** Build the initial SSE payload from a freshly-read view. */
export function progressFromView(view: DeployView): DeployProgress {
  return {
    deployId: view.deployId,
    state: view.state,
    url: view.active ? appUrl(view.workspaceSlug, view.appSlug) : undefined,
    error: view.error ?? undefined,
    terminal: isTerminalState(view.state),
  };
}

const encoder = new TextEncoder();
function sseChunk(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * A `text/event-stream` body for one deploy: the current state, then every
 * subsequent worker publish, closing once terminal.
 */
export function createDeployEventStream(
  deployId: string,
  initial: DeployProgress
): ReadableStream<Uint8Array> {
  const channel = deployChannel(deployId);
  let sub: Redis | null = null;
  let closed = false;

  async function cleanup(): Promise<void> {
    if (!sub) return;
    const s = sub;
    sub = null;
    try {
      await s.unsubscribe(channel);
    } catch {
      /* connection may already be gone */
    }
    s.disconnect();
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sseChunk(initial));
      if (initial.terminal || isTerminalState(initial.state)) {
        closed = true;
        controller.close();
        return;
      }
      sub = getRedis().duplicate();
      sub.on('message', (_chan, payload) => {
        if (closed) return;
        let msg: DeployProgress;
        try {
          msg = JSON.parse(payload) as DeployProgress;
        } catch {
          return;
        }
        try {
          controller.enqueue(sseChunk(msg));
        } catch {
          return;
        }
        if (msg.terminal || isTerminalState(msg.state)) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          void cleanup();
        }
      });
      try {
        await sub.subscribe(channel);
      } catch {
        /* if we cannot subscribe, the stream simply carries only the initial event */
      }
    },
    async cancel() {
      closed = true;
      await cleanup();
    },
  });
}
