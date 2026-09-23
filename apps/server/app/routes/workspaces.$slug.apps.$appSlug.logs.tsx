// Thin route glue (M2-03, NSO-301) — Logs tab (get_logs data); logic lives in @drobek/dashboard.
export { loader } from '@drobek/dashboard/routes/workspaces.$slug.apps.$appSlug.logs.server';
export { default, meta } from '@drobek/dashboard/routes/workspaces.$slug.apps.$appSlug.logs';
