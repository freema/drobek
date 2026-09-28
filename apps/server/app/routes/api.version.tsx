import { activeModules } from '@drobek/modules';

const STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

function commitTime(): string | null {
  const raw = process.env.GIT_COMMIT_TIME;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * D3 (ratified): `/api/version` returns the git sha baked into the running
 * image (build-arg → env GIT_SHA); "dev" outside a release build. M4-03: plus
 * the release version (build-arg VERSION → env DROBEK_VERSION, the tag
 * `vX.Y.Z` a release image is built from; "dev" otherwise). NSO-345: plus the
 * active platform modules (`[{ name, version, source, contract }]`, no paths).
 * NSO-340: plus `name`, `commitTime` (the committer time of GIT_SHA, build-arg
 * COMMIT_TIME → env GIT_COMMIT_TIME, UTC ISO; null when unknown — the same
 * sources rebuild to the same value) and `startedAt` (when this process
 * started, i.e. when the container was last (re)started).
 */
export async function loader(): Promise<Response> {
  return Response.json(
    {
      name: 'drobek',
      sha: process.env.GIT_SHA || 'dev',
      version: process.env.DROBEK_VERSION || 'dev',
      commitTime: commitTime(),
      startedAt: STARTED_AT,
      modules: await activeModules(),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
