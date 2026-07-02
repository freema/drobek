import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),
  route('healthz', 'routes/healthz.tsx'),
  route('api/version', 'routes/api.version.tsx'),
] satisfies RouteConfig;
