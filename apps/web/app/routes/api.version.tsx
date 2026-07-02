/**
 * D3 (ratified): `/api/version` returns the git sha baked into the running
 * image (build-arg → env GIT_SHA); "dev" outside a release build.
 */
export function loader(): Response {
  return Response.json(
    { sha: process.env.GIT_SHA || 'dev' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
