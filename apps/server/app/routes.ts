import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),
  route('healthz', 'routes/healthz.tsx'),
  route('api/version', 'routes/api.version.tsx'),
  // The release notes of the running version, and the dashboard notice's dismissal.
  route('whats-new', 'routes/whats-new.ts'),
  route('whats-new/dismiss', 'routes/whats-new.dismiss.ts'),
  // The /llms.txt convention + a human build page.
  // Rendered from the @drobek/agent-dx manifest so they never drift from the
  // real MCP tools.
  route('robots.txt', 'routes/robots-txt.ts'),
  route('favicon.ico', 'routes/favicon-ico.ts'),
  route('llms.txt', 'routes/llms-txt.ts'),
  route('llms-full.txt', 'routes/llms-full-txt.ts'),
  route('build-with-your-agent', 'routes/build-with-your-agent.tsx'),
  // Email magic-code auth + Redis sessions.
  route('login', 'routes/login.tsx'),
  route('login/verify', 'routes/login.verify.tsx'),
  route('auth/logout', 'routes/auth.logout.tsx'),
  // Google OIDC login — account-link by email.
  route('auth/google', 'routes/auth.google.tsx'),
  route('auth/google/callback', 'routes/auth.google.callback.tsx'),
  route('me', 'routes/me.tsx'),
  // The account area — personal API keys + OAuth connections.
  route('me/api-keys', 'routes/me.api-keys.tsx'),
  route('me/connections', 'routes/me.connections.tsx'),
  // Delete your account (a fresh e-mail code confirms it).
  route('me/delete', 'routes/me.delete.tsx'),
  // Workspaces (personal+team) + roles + Redis invites.
  route('workspaces', 'routes/workspaces.tsx'),
  route('workspaces/:slug', 'routes/workspaces.$slug.tsx'),
  route('workspaces/:slug/invite', 'routes/workspaces.$slug.invite.tsx'),
  // A workspace admin deletes a team workspace with its apps (type the slug).
  route('workspaces/:slug/delete', 'routes/workspaces.$slug.delete.tsx'),
  route('invite/:token', 'routes/invite.$token.tsx'),
  // The workspace Activity view — the append-only audit
  // trail (who created/published/invited, and whether it was the agent
  // or a human), admin/super-admin only, + a CSV export.
  route('workspaces/:slug/activity', 'routes/workspaces.$slug.activity.tsx'),
  route(
    'workspaces/:slug/activity/export.csv',
    'routes/workspaces.$slug.activity.export-csv.ts'
  ),
  // The workspace-level Upstreams config — register/list/
  // delete secret-injecting upstreams (workspace-admin/super-admin only). Apps
  // call them through the `proxy` platform module.
  route('workspaces/:slug/upstreams', 'routes/workspaces.$slug.upstreams.tsx'),
  // The platform modules this server runs (version, source,
  // contract, slots, limits for the workspace, error codes) — read-only,
  // viewer+ — with each opt-in module's state for the workspace and its
  // enable switch (super-admin only).
  route('workspaces/:slug/modules', 'routes/workspaces.$slug.modules.tsx'),
  // Minimal dashboard — apps list, per-app version
  // history + role-gated publish. Static `apps` segment keeps these specific
  // enough not to shadow `/workspaces/:slug/invite`.
  route('workspaces/:slug/apps', 'routes/workspaces.$slug.apps.tsx'),
  route(
    'workspaces/:slug/apps/:appSlug',
    'routes/workspaces.$slug.apps.$appSlug.tsx'
  ),
  // The app page's Files tab (tree, read-only viewer, ZIP of
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
  // Dashboard Data tab (lite) — collections list, collection
  // table (filter/sort/paginate through the query API), streamed CSV export,
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
  // The Modules tab — config forms, pending confirmations,
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
  // The app's custom domains — add, DNS instructions,
  // verify (TXT + CNAME), primary (redirect), remove. editor+ for changes.
  route(
    'workspaces/:slug/apps/:appSlug/domains',
    'routes/workspaces.$slug.apps.$appSlug.domains.tsx'
  ),
  // The owner's module tabs of an app — Forms (submissions,
  // filter + CSV + delete), Users (end users: role, block, sign everyone out),
  // Uploads (files module, nosniff preview/download, delete), Logs (get_logs).
  route('workspaces/:slug/apps/:appSlug/forms', 'routes/workspaces.$slug.apps.$appSlug.forms.tsx'),
  route('workspaces/:slug/apps/:appSlug/forms/export.csv', 'routes/workspaces.$slug.apps.$appSlug.forms.export-csv.ts'),
  route('workspaces/:slug/apps/:appSlug/end-users', 'routes/workspaces.$slug.apps.$appSlug.end-users.tsx'),
  route('workspaces/:slug/apps/:appSlug/assets', 'routes/workspaces.$slug.apps.$appSlug.assets.tsx'),
  route('workspaces/:slug/apps/:appSlug/uploads', 'routes/workspaces.$slug.apps.$appSlug.uploads.tsx'),
  route('workspaces/:slug/apps/:appSlug/uploads/:fileId', 'routes/workspaces.$slug.apps.$appSlug.uploads.$fileId.ts'),
  route('workspaces/:slug/apps/:appSlug/logs', 'routes/workspaces.$slug.apps.$appSlug.logs.tsx'),
  // The Analytics tab — page views, visitors, top pages and referrers (get_analytics).
  route('workspaces/:slug/apps/:appSlug/analytics', 'routes/workspaces.$slug.apps.$appSlug.analytics.tsx'),
  // The owner confirms/rejects a pending platform-module
  // change (configure_module → confirm_url; the page calls this API).
  route(
    'api/apps/:id/modules/:module/:decision',
    'routes/api.apps.$id.modules.$module.$decision.ts'
  ),
  // The owner signs every end user of an app out (session
  // epoch bump, the users page calls this API).
  route(
    'api/apps/:id/end-user-sessions/revoke',
    'routes/api.apps.$id.end-user-sessions.revoke.ts'
  ),
  // MCP OAuth 2.1 Authorization Server.
  route(
    '.well-known/oauth-authorization-server',
    'routes/well-known.oauth-authorization-server.ts'
  ),
  route('oauth/register', 'routes/oauth.register.ts'),
  route('oauth/authorize', 'routes/oauth.authorize.tsx'),
  route('oauth/token', 'routes/oauth.token.ts'),
  // Abuse — the public report form (every app host's
  // /.well-known/drobek-report points here) and the super-admin queue.
  route('report', 'routes/report.tsx'),
  route('admin/abuse', 'routes/admin.abuse.tsx'),
  // The super-admin approves workspaces for publishing (PUBLISH_APPROVAL=approval).
  route('admin/publishing', 'routes/admin.publishing.tsx'),
  // The public gallery list (read-only JSON, CORS *, 404 unless
  // GALLERY_ENABLED) — the operator's website renders it.
  route('api/public/gallery', 'routes/api.public.gallery.ts'),
  // The gallery's Duplicate button — sign in, pick a workspace, copy the app.
  route('duplicate/:slug', 'routes/duplicate.$slug.tsx'),
  // The gallery's counting link (302 to the app) and the like page (signed-in accounts).
  route('gallery/open/:slug', 'routes/gallery.open.$slug.ts'),
  route('gallery/like/:slug', 'routes/gallery.like.$slug.tsx'),
  // The IdP callback of an end-user sign-in provider (the auth
  // module's `auth.provider` slot) — one redirect URI per server; answers a
  // 302 with a handoff code to the app host, never touches the dashboard session.
  route('__drobek/auth/callback/:provider', 'routes/drobek.auth.callback.$provider.ts'),
] satisfies RouteConfig;
