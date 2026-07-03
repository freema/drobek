/**
 * @drobek/dashboard — the U8 minimal dashboard (PHY-74 slice / PHY-62): the
 * workspace apps list, per-app deploy history, and the role-gated rollback
 * action. Heavy logic lives HERE; apps/web (and the private drobek-web app)
 * register thin route files that re-export the route modules under
 * `@drobek/dashboard/routes/*` — exactly like @drobek/tenancy / @drobek/auth.
 *
 * This package composes the workspace/role primitives (@drobek/tenancy), the
 * apps/deploys tables (@drobek/db) and the rollback primitive (@drobek/deploy)
 * — it sits ABOVE them, so nothing in those packages imports it (no cycle).
 */
export {
  servePath,
  shapeApps,
  shapeDeployHistory,
  deployShortId,
  lintStatusOf,
  canRollback,
  type AppVisibility,
  type AppLiveStatus,
  type DeployStateName,
  type LintStatus,
  type AppListRow,
  type AppListItem,
  type DeployHistoryRow,
  type DeployHistoryItem,
} from './view.js';
export {
  listWorkspaceApps,
  loadAppForView,
  listAppDeploys,
  type AppDetail,
} from './apps.server.js';
