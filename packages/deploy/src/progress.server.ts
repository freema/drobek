/**
 * Deploy progress over redis pub/sub (U6, PHY-57). The worker PUBLISHES a
 * `DeployProgress` JSON message to `drobek:deploy:<id>` at each pipeline step;
 * the web SSE route (see events.ts) SUBSCRIBES and relays them to the dashboard.
 */
import { getRedis } from '@drobek/core';
import { deployChannel } from './constants.js';
import type { DeployState } from './types.js';

export interface DeployProgress {
  deployId: string;
  state: DeployState;
  /** Coarse step label (lint | store | activate). */
  step?: string;
  message?: string;
  url?: string;
  error?: string;
  /** True once no further messages will follow (ready | failed). */
  terminal?: boolean;
}

/** Publish one progress message (fire-and-forget from the worker's view). */
export async function publishDeployProgress(p: DeployProgress): Promise<void> {
  await getRedis().publish(deployChannel(p.deployId), JSON.stringify(p));
}
