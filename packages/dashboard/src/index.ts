/**
 * @drobek/dashboard — the minimal dashboard (PHY-74 slice / PHY-62): the
 * workspace apps list, per-app version history, and the role-gated publish
 * action (publishing an older version is the rollback). Heavy logic lives HERE; apps/web (and the private drobek-web app)
 * register thin route files that re-export the route modules under
 * `@drobek/dashboard/routes/*` — exactly like @drobek/tenancy / @drobek/auth.
 *
 * This package composes the workspace/role primitives (@drobek/tenancy), the
 * apps tables (@drobek/db) and the version primitives (@drobek/apps)
 * — it sits ABOVE them, so nothing in those packages imports it (no cycle).
 */
export {
  shapeApps,
  shapeVersionHistory,
  canPublish,
  canDeleteRecord,
  type AppVisibility,
  type AppLiveStatus,
  type CompileStatusName,
  type AppListRow,
  type AppListItem,
  type VersionHistoryRow,
  type VersionHistoryItem,
} from './view.js';
export {
  listWorkspaceApps,
  loadAppForView,
  type AppDetail,
} from './apps.server.js';
export { APP_TABS, activeAppTab, appBasePath, appTabHref, type AppTab } from './app-tabs.js';
export {
  buildFileTree,
  compileSummary,
  filterApps,
  formatAgo,
  parseAppListFilters,
  safeRedirectTo,
  shapeLock,
  type AppListFilters,
  type LockView,
  type TreeNode,
} from './app-view.js';
export { highlight, languageOf, type Language, type Token, type TokenKind } from './highlight.js';
