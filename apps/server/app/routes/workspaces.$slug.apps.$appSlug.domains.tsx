// Thin route glue (M3-01, NSO-292) — logic lives in @drobek/dashboard + @drobek/domains.
export { action, loader } from '@drobek/dashboard/routes/workspaces.$slug.apps.$appSlug.domains.server';
export { default, meta } from '@drobek/dashboard/routes/workspaces.$slug.apps.$appSlug.domains';
