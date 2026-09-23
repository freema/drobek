// Thin route glue (M2-02, NSO-291) — logic lives in @drobek/dashboard. This
// page is configure_module's `confirm_url`.
export { action, loader } from '@drobek/dashboard/routes/workspaces.$slug.apps.$appSlug.modules.$module.server';
export { default, meta } from '@drobek/dashboard/routes/workspaces.$slug.apps.$appSlug.modules.$module';
