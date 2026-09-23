// Thin route glue (PHY-85) — the workspace Activity (audit) view lives in
// @drobek/dashboard. Server (loader + authz) and component are split so the
// production client build never pulls the db-backed loader in.
export { loader } from '@drobek/dashboard/routes/workspaces.$slug.activity.server';
export { default, meta } from '@drobek/dashboard/routes/workspaces.$slug.activity';
