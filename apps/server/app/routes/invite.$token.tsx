// Thin route glue — all real logic lives in @drobek/tenancy.
export { action, loader } from '@drobek/tenancy/routes/invite.$token.server';
export { default, meta, ErrorBoundary } from '@drobek/tenancy/routes/invite.$token';
