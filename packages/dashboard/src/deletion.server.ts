/**
 * What the dashboard's workspace and account deletions run around each app
 * they delete (@drobek/tenancy deletes and purges the apps): the platform
 * modules' onAppDelete, and after the purge the apps' end-user sessions in
 * Redis — the same as a single app's delete plus the purge job.
 */
import { getRedis } from '@drobek/core';
import { forgetEndUserSessions, moduleRuntime, type EndUserScanRedis } from '@drobek/modules';
import type { AppDeletionHooks } from '@drobek/tenancy';

export async function appDeletionHooks(): Promise<AppDeletionHooks> {
  const runtime = await moduleRuntime();
  return {
    onAppDelete: (app) => runtime.runHook('onAppDelete', app),
    afterPurge: async (appIds) => {
      await forgetEndUserSessions(getRedis() as unknown as EndUserScanRedis, appIds);
    },
  };
}
