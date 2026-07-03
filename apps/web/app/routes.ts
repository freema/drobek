import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),
  route('healthz', 'routes/healthz.tsx'),
  route('api/version', 'routes/api.version.tsx'),
  // M1b Agent DX (PHY-124): the /llms.txt convention + a human build page.
  // Rendered from the @drobek/agent-dx manifest so they never drift from the
  // real MCP tools.
  route('llms.txt', 'routes/llms-txt.ts'),
  route('llms-full.txt', 'routes/llms-full-txt.ts'),
  route('build-with-your-agent', 'routes/build-with-your-agent.tsx'),
  // U2 (PHY-53): email magic-code auth + Redis sessions.
  route('login', 'routes/login.tsx'),
  route('login/verify', 'routes/login.verify.tsx'),
  route('auth/logout', 'routes/auth.logout.tsx'),
  // U3 (PHY-53): Google OIDC login — account-link by email.
  route('auth/google', 'routes/auth.google.tsx'),
  route('auth/google/callback', 'routes/auth.google.callback.tsx'),
  route('me', 'routes/me.tsx'),
  // U4 (PHY-54): workspaces (personal+team) + roles + Redis invites.
  route('workspaces', 'routes/workspaces.tsx'),
  route('workspaces/:slug', 'routes/workspaces.$slug.tsx'),
  route('workspaces/:slug/invite', 'routes/workspaces.$slug.invite.tsx'),
  route('invite/:token', 'routes/invite.$token.tsx'),
  // U8 (PHY-74 slice / PHY-62): minimal dashboard — apps list, per-app deploy
  // history + role-gated rollback. Static `apps` segment keeps these specific
  // enough not to shadow `/workspaces/:slug/invite`.
  route('workspaces/:slug/apps', 'routes/workspaces.$slug.apps.tsx'),
  route(
    'workspaces/:slug/apps/:appSlug',
    'routes/workspaces.$slug.apps.$appSlug.tsx'
  ),
  // M1b (PHY-121): dashboard Data tab (lite) — collections list, collection
  // table (filter/sort/paginate through the U10 query API), streamed CSV export,
  // read-only record viewer, editor+ delete. Static `data` segment keeps these
  // specific (they never fall through to the serve splat).
  route(
    'workspaces/:slug/apps/:appSlug/data',
    'routes/workspaces.$slug.apps.$appSlug.data.tsx'
  ),
  route(
    'workspaces/:slug/apps/:appSlug/data/:collection',
    'routes/workspaces.$slug.apps.$appSlug.data.$collection.tsx'
  ),
  route(
    'workspaces/:slug/apps/:appSlug/data/:collection/export.csv',
    'routes/workspaces.$slug.apps.$appSlug.data.$collection.export-csv.ts'
  ),
  // P0-B blob skeleton (D2/PHY-100): signed-upload sink + read-back path.
  route('__upload/:token', 'routes/__upload.$token.ts'),
  route('__blob/:sha256', 'routes/__blob.$sha256.ts'),
  // U6 (PHY-57): deploy progress SSE stream (dashboard session-gated).
  route('api/deploys/:id/events', 'routes/api.deploys.$id.events.ts'),
  // U5 (PHY-71/PHY-53): MCP OAuth 2.1 Authorization Server.
  route(
    '.well-known/oauth-authorization-server',
    'routes/well-known.oauth-authorization-server.ts'
  ),
  route('oauth/register', 'routes/oauth.register.ts'),
  route('oauth/authorize', 'routes/oauth.authorize.tsx'),
  route('oauth/token', 'routes/oauth.token.ts'),
  // U10 (PHY-55/PHY-56): REST Data API. More-specific static `data` segment →
  // these rank above the serve splat below (they never fall through to it).
  route(
    ':ws/app/:slug/data/:collection',
    'routes/serve.app.data.$collection.ts'
  ),
  route(
    ':ws/app/:slug/data/:collection/:id',
    'routes/serve.app.data.$collection.$id.ts'
  ),
  // U7 (PHY-58): hardened same-origin app serving. The literal `app` middle
  // segment makes `:ws/app/:slug/*` specific enough that it never shadows the
  // dashboard routes above (all of which have a static first segment).
  route(':ws/app/:slug/*', 'routes/serve.app.ts'),
] satisfies RouteConfig;
