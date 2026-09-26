import { activeModules } from '@drobek/modules';

/**
 * D3 (ratified): `/api/version` returns the git sha baked into the running
 * image (build-arg → env GIT_SHA); "dev" outside a release build. M4-03: plus
 * the release version (build-arg VERSION → env DROBEK_VERSION, the tag
 * `vX.Y.Z` a release image is built from; "dev" otherwise). NSO-345: plus the
 * active platform modules (`[{ name, version, source, contract }]`, no paths).
 */
export async function loader(): Promise<Response> {
  return Response.json(
    { sha: process.env.GIT_SHA || 'dev', version: process.env.DROBEK_VERSION || 'dev', modules: await activeModules() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
