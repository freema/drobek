// Thin route glue (NSO-358) — Assets tab (the app's video, audio, images, fonts); logic lives in @drobek/dashboard.
export { action, loader } from '@drobek/dashboard/routes/workspaces.$slug.apps.$appSlug.assets.server';
export { default, meta } from '@drobek/dashboard/routes/workspaces.$slug.apps.$appSlug.assets';
