// Thin route glue (PHY-59) — logic lives in @drobek/dashboard + @drobek/proxy.
export {
  loader,
  action,
} from '@drobek/dashboard/routes/workspaces.$slug.upstreams.server';
export { default, meta } from '@drobek/dashboard/routes/workspaces.$slug.upstreams';
