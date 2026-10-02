// Thin route glue — all real logic lives in @drobek/tenancy.
export { action, loader } from '@drobek/tenancy/routes/workspaces.$slug.server';
export { default, meta } from '@drobek/tenancy/routes/workspaces.$slug';
