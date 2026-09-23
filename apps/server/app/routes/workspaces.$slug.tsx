// Thin route glue (U4, PHY-54) — all real logic lives in @drobek/tenancy.
export { loader } from '@drobek/tenancy/routes/workspaces.$slug.server';
export { default, meta } from '@drobek/tenancy/routes/workspaces.$slug';
