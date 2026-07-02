import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),
  route('healthz', 'routes/healthz.tsx'),
  route('api/version', 'routes/api.version.tsx'),
  // P0-B blob skeleton (D2/PHY-100): signed-upload sink + read-back path.
  route('__upload/:token', 'routes/__upload.$token.ts'),
  route('__blob/:sha256', 'routes/__blob.$sha256.ts'),
] satisfies RouteConfig;
