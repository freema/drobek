// Thin route glue (U3.5a/U4, PHY-53/54) — auth logic lives in @drobek/auth;
// @drobek/tenancy wraps the action to ensure the personal workspace on login.
export { action, loader } from '@drobek/tenancy/routes/login.verify.server';
export { default, meta } from '@drobek/auth/routes/login.verify';
