// Thin route glue (NSO-347, NSO-346) — logic lives in @drobek/dashboard + @drobek/modules.
export { loader, action } from '@drobek/dashboard/routes/workspaces.$slug.modules.server';
export { default, meta } from '@drobek/dashboard/routes/workspaces.$slug.modules';
