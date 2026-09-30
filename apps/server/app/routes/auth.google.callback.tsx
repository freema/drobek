// Thin route glue — auth logic lives in @drobek/auth;
// @drobek/tenancy wraps the loader to ensure the personal workspace on login.
export { loader } from '@drobek/tenancy/routes/auth.google.callback.server';
export { default } from '@drobek/auth/routes/auth.google.callback';
