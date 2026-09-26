import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),
  route('healthz', 'routes/healthz.tsx'),
  route('api/version', 'routes/api.version.tsx'),
  // M1b Agent DX (PHY-124): the /llms.txt convention + a human build page.
  // Rendered from the @drobek/agent-dx manifest so they never drift from the
  // real MCP tools.
  route('llms.txt', 'routes/llms-txt.ts'),
  route('llms-full.txt', 'routes/llms-full-txt.ts'),
  route('build-with-your-agent', 'routes/build-with-your-agent.tsx'),
  // U2 (PHY-53): email magic-code auth + Redis sessions.
  route('login', 'routes/login.tsx'),
  route('login/verify', 'routes/login.verify.tsx'),
  route('auth/logout', 'routes/auth.logout.tsx'),
  // U3 (PHY-53): Google OIDC login — account-link by email.
  route('auth/google', 'routes/auth.google.tsx'),
  route('auth/google/callback', 'routes/auth.google.callback.tsx'),
  route('me', 'routes/me.tsx'),
  // M2-04 (NSO-284): the account area — personal API keys + OAuth connections.
  route('me/api-keys', 'routes/me.api-keys.tsx'),
  route('me/connections', 'routes/me.connections.tsx'),
  // U4 (PHY-54): workspaces (personal+team) + roles + Redis invites.
  route('workspaces', 'routes/workspaces.tsx'),
  route('workspaces/:slug', 'routes/workspaces.$slug.tsx'),
  route('workspaces/:slug/invite', 'routes/workspaces.$slug.invite.tsx'),
  route('invite/:token', 'routes/invite.$token.tsx'),
  // PHY-85 (governance v1): the workspace Activity view — the append-only audit
  // trail (who created/published/invited, and whether it was the agent
  // or a human), admin/super-admin only, + a CSV export.
  route('workspaces/:slug/activity', 'routes/workspaces.$slug.activity.tsx'),
  route(
    'workspaces/:slug/activity/export.csv',
    'routes/workspaces.$slug.activity.export-csv.ts'
  ),
  // PHY-59 (BFF proxy v1): the workspace-level Upstreams config — register/list/
  // delete secret-injecting upstreams (workspace-admin/super-admin only). Apps
  // call them through the `proxy` platform module (NSO-297).
  route('workspaces/:slug/upstreams', 'routes/workspaces.$slug.upstreams.tsx'),
  // NSO-347: the platform modules this server runs (version, source, contract,
  // slots, limits for the workspace, error codes) — read-only, viewer+.
  route('workspaces/:slug/modules', 'routes/workspaces.$slug.modules.tsx'),
  // U8 (PHY-74 slice / PHY-62): minimal dashboard — apps list, per-app version
  // history + role-gated publish. Static `apps` segment keeps these specific
  // enough not to shadow `/workspaces/:slug/invite`.
  route('workspaces/:slug/apps', 'routes/workspaces.$slug.apps.tsx'),
  route(
    'workspaces/:slug/apps/:appSlug',
    'routes/workspaces.$slug.apps.$appSlug.tsx'
  ),
  // M2-01 (NSO-288): the app page's Files tab (tree, read-only viewer, ZIP of
  // a version) and Settings tab (visibility + password, frame-ancestors,
  // delete). Tabs are listed in @drobek/dashboard app-tabs.ts.
  route(
    'workspaces/:slug/apps/:appSlug/files',
    'routes/workspaces.$slug.apps.$appSlug.files.tsx'
  ),
  route(
    'workspaces/:slug/apps/:appSlug/files/download',
    'routes/workspaces.$slug.apps.$appSlug.files.download.ts'
  ),
  route(
    'workspaces/:slug/apps/:appSlug/settings',
    'routes/workspaces.$slug.apps.$appSlug.settings.tsx'
  ),
  // M1b (PHY-121): dashboard Data tab (lite) — collections list, collection
  // table (filter/sort/paginate through the U10 query API), streamed CSV export,
  // read-only record viewer, editor+ delete.
  route(
    'workspaces/:slug/apps/:appSlug/data',
    'routes/workspaces.$slug.apps.$appSlug.data.tsx'
  ),
  route(
    'workspaces/:slug/apps/:appSlug/data/:collection',
    'routes/workspaces.$slug.apps.$appSlug.data.$collection.tsx'
  ),
  route(
    'workspaces/:slug/apps/:appSlug/data/:collection/export.csv',
    'routes/workspaces.$slug.apps.$appSlug.data.$collection.export-csv.ts'
  ),
  // M2-02 (NSO-291): the Modules tab — config forms, pending confirmations,
  // secrets, the data collections/rules editor, per-app upstreams. The module
  // page is configure_module's confirm_url.
  route(
    'workspaces/:slug/apps/:appSlug/modules',
    'routes/workspaces.$slug.apps.$appSlug.modules.tsx'
  ),
  route(
    'workspaces/:slug/apps/:appSlug/modules/:module',
    'routes/workspaces.$slug.apps.$appSlug.modules.$module.tsx'
  ),
  // M3-01 (NSO-292): the app's custom domains — add, DNS instructions,
  // verify (TXT + CNAME), primary (redirect), remove. editor+ for changes.
  route(
    'workspaces/:slug/apps/:appSlug/domains',
    'routes/workspaces.$slug.apps.$appSlug.domains.tsx'
  ),
  // M2-03 (NSO-301): the owner's module tabs of an app — Forms (submissions,
  // filter + CSV + delete), Users (end users: role, block, sign everyone out),
  // Uploads (files module, nosniff preview/download, delete), Logs (get_logs).
  route('workspaces/:slug/apps/:appSlug/forms', 'routes/workspaces.$slug.apps.$appSlug.forms.tsx'),
  route('workspaces/:slug/apps/:appSlug/forms/export.csv', 'routes/workspaces.$slug.apps.$appSlug.forms.export-csv.ts'),
  route('workspaces/:slug/apps/:appSlug/end-users', 'routes/workspaces.$slug.apps.$appSlug.end-users.tsx'),
  route('workspaces/:slug/apps/:appSlug/assets', 'routes/workspaces.$slug.apps.$appSlug.assets.tsx'),
  route('workspaces/:slug/apps/:appSlug/uploads', 'routes/workspaces.$slug.apps.$appSlug.uploads.tsx'),
  route('workspaces/:slug/apps/:appSlug/uploads/:fileId', 'routes/workspaces.$slug.apps.$appSlug.uploads.$fileId.ts'),
  route('workspaces/:slug/apps/:appSlug/logs', 'routes/workspaces.$slug.apps.$appSlug.logs.tsx'),
  // M1-01 (NSO-287): the owner confirms/rejects a pending platform-module
  // change (configure_module → confirm_url; the M2-02 page calls this API).
  route(
    'api/apps/:id/modules/:module/:decision',
    'routes/api.apps.$id.modules.$module.$decision.ts'
  ),
  // M1-02 (NSO-294): the owner signs every end user of an app out (session
  // epoch bump, PHY-76 #9; the M2-03 users page calls this API).
  route(
    'api/apps/:id/end-user-sessions/revoke',
    'routes/api.apps.$id.end-user-sessions.revoke.ts'
  ),
  // U5 (PHY-71/PHY-53): MCP OAuth 2.1 Authorization Server.
  route(
    '.well-known/oauth-authorization-server',
    'routes/well-known.oauth-authorization-server.ts'
  ),
  route('oauth/register', 'routes/oauth.register.ts'),
  route('oauth/authorize', 'routes/oauth.authorize.tsx'),
  route('oauth/token', 'routes/oauth.token.ts'),
  // M4-02 (NSO-293): abuse — the public report form (every app host's
  // /.well-known/drobek-report points here) and the super-admin queue.
  route('report', 'routes/report.tsx'),
  route('admin/abuse', 'routes/admin.abuse.tsx'),
  // NSO-340: the public gallery list (read-only JSON, CORS *, 404 unless
  // GALLERY_ENABLED) — the operator's website renders it.
  route('api/public/gallery', 'routes/api.public.gallery.ts'),
  // NSO-297: the old dashboard-host proxy (`/:ws/api/proxy/:name/*`) is gone —
  // apps call upstreams on their own host through the `proxy` platform module
  // (`/__drobek/v1/proxy/:upstream/*`).
] satisfies RouteConfig;
