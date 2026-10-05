// Thin route glue — logic lives in @drobek/dashboard.
export { action, headers, loader } from '@drobek/dashboard/routes/workspaces.$slug.apps.$appSlug.server';
export { default, ErrorBoundary, meta } from '@drobek/dashboard/routes/workspaces.$slug.apps.$appSlug';
