import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),
  route('healthz', 'routes/healthz.tsx'),
  route('api/version', 'routes/api.version.tsx'),
  // U2 (PHY-53): email magic-code auth + Redis sessions.
  route('login', 'routes/login.tsx'),
  route('login/verify', 'routes/login.verify.tsx'),
  route('auth/logout', 'routes/auth.logout.tsx'),
  route('me', 'routes/me.tsx'),
  // P0-B blob skeleton (D2/PHY-100): signed-upload sink + read-back path.
  route('__upload/:token', 'routes/__upload.$token.ts'),
  route('__blob/:sha256', 'routes/__blob.$sha256.ts'),
] satisfies RouteConfig;
