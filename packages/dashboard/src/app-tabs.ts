/**
 * The app page's tabs (NSO-288) — ONE data-driven list, rendered by
 * <AppTabs> in the app header on every app page. `to` is relative to the
 * app's base path `/workspaces/<ws>/apps/<app>` ('' = the base page).
 *
 * Adding a tab = one line here plus its route (e.g. `modules` for M2-02,
 * `domains` for M3). Keep the order the user reads left to right.
 */
export interface AppTab {
  /** Stable key (data-tab attribute, active-tab matching). */
  key: string;
  /** Path segment under the app's base path; '' for the base page. */
  to: string;
  label: string;
}

// The keys / paths below are route segments; the Data, Forms, Users and
// Uploads tabs are served by whichever module declares the authority.
export const APP_TABS: readonly AppTab[] = [
  { key: 'overview', to: '', label: 'Overview' },
  { key: 'files', to: 'files', label: 'Files' },
  { key: 'assets', to: 'assets', label: 'Assets' },
  // module-name-guard: allow — the Data tab's route segment, not a module name.
  { key: 'data', to: 'data', label: 'Data' },
  { key: 'modules', to: 'modules', label: 'Modules' },
  { key: 'forms', to: 'forms', label: 'Forms' },
  { key: 'end-users', to: 'end-users', label: 'Users' },
  { key: 'uploads', to: 'uploads', label: 'Uploads' },
  { key: 'logs', to: 'logs', label: 'Logs' },
  { key: 'domains', to: 'domains', label: 'Domains' },
  { key: 'settings', to: 'settings', label: 'Settings' },
];

/** `/workspaces/<ws>/apps/<app>` — every tab lives under it. */
export function appBasePath(workspaceSlug: string, appSlug: string): string {
  return `/workspaces/${workspaceSlug}/apps/${appSlug}`;
}

export function appTabHref(workspaceSlug: string, appSlug: string, tab: AppTab): string {
  const base = appBasePath(workspaceSlug, appSlug);
  return tab.to ? `${base}/${tab.to}` : base;
}

/** The tab a pathname belongs to (the longest matching tab path; base → overview). */
export function activeAppTab(pathname: string, workspaceSlug: string, appSlug: string): string {
  const base = appBasePath(workspaceSlug, appSlug);
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\/+/, '') : '';
  let best: AppTab | undefined;
  for (const t of APP_TABS) {
    if (!t.to) continue;
    if ((rest === t.to || rest.startsWith(`${t.to}/`)) && (!best || t.to.length > best.to.length)) best = t;
  }
  return (best ?? APP_TABS[0]).key;
}
