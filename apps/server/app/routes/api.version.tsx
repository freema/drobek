/**
 * D3 (ratified): `/api/version` returns the git sha baked into the running
 * image (build-arg → env GIT_SHA); "dev" outside a release build. M4-03: plus
 * the release version (build-arg VERSION → env DROBEK_VERSION, the tag
 * `vX.Y.Z` a release image is built from; "dev" otherwise).
 */
export function loader(): Response {
  return Response.json(
    { sha: process.env.GIT_SHA || 'dev', version: process.env.DROBEK_VERSION || 'dev' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
