import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),
  route('healthz', 'routes/healthz.tsx'),
  route('api/version', 'routes/api.version.tsx'),
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
  // P0-B blob skeleton (D2/PHY-100): signed-upload sink + read-back path.
  route('__upload/:token', 'routes/__upload.$token.ts'),
  route('__blob/:sha256', 'routes/__blob.$sha256.ts'),
  // U5 (PHY-71/PHY-53): MCP OAuth 2.1 Authorization Server.
  route(
    '.well-known/oauth-authorization-server',
    'routes/well-known.oauth-authorization-server.ts'
  ),
  route('oauth/register', 'routes/oauth.register.ts'),
  route('oauth/authorize', 'routes/oauth.authorize.tsx'),
  route('oauth/token', 'routes/oauth.token.ts'),
] satisfies RouteConfig;
