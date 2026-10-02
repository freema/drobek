# Changelog — drobek (core)

## v0.7.5 — 2026-10-02

Before you upgrade: this release deletes data on its own for the first time. An app deleted more than `APP_PURGE_AFTER_DAYS` (30) ago is removed for good with everything it stored, and each app keeps its newest `APP_VERSIONS_KEEP` (200) versions plus the published one and the ones kept for a rollback; set either variable before the first start on this version if you want other values. Core migrations 0033–0036 are applied at start, and an older image then refuses to start on the migrated database.

### Added
- **The agent can now tell whether the newest version rendered in a browser** (NSO-437): `get_app` returns `render: { version, beacon, page_loads, errors }` for the newest version, and `get_logs('runtime')` carries the same counts on its envelope (`latest_version`, `beacon`, `page_loads`, `page_errors`), together with a note telling the agent to hand the user the preview_url while `page_loads` is 0. Each runtime entry now has a `version`.
- **The browser beacon also reports files that failed to load and requests the app CSP blocked** (NSO-437): Failed scripts, stylesheets, images and media are reported as `type: "resource"`, and CSP blocks as `type: "csp"` with the blocked origin + path and the directive. Query strings are never sent. Each page sends one load ping, which drobek counts per version in the new `app_version_loads` table (counts only, kept 30 days). Load pings have their own rate-limit buckets, so a popular app's error budget is not spent on them. Every HTML response from an app host carries `Server-Timing: drobek-version;desc="N"`. `"beacon": false` in drobek.json turns all of this off, and `render.beacon` then says so.
- **read_file reads several files at once, a part of a file, or searches the sources** (NSO-438): `paths` (up to 20) reads several files in one call, and `offset` / `limit` return part of each file; every text file states its `total_lines`. The first file always comes back. Each further file comes back only while the text stays within `COMPILE_MAX_FILE_BYTES` (512 KiB by default); the rest is listed under `omitted`, and paths the version does not have are listed under `missing`. With `search`, the agent gets the lines of the version's text files that contain a literal text (optional `ignore_case`; `path` / `paths` narrow the search to files or folders) as `{ path, line, column, text }`. It returns at most `limit` lines (default 50, at most 100) together with the total count. The search runs in linear time on any input, since it does not use a regex. Everything still arrives only inside the untrusted envelope (`<untrusted-app-file>` per file, `<untrusted-app-search>` for a search), without structuredContent. A single `read_file({ app_id, path })` call answers as before, with an added `total_lines`.
- **An agent can now unpublish, protect, embed, unlock and delete an app over MCP** (NSO-440): Five new tools do what the dashboard's app page and Settings tab do, through the same audited `@drobek/apps` functions, recorded as the agent. `unpublish` and `set_visibility` need the `publish` scope; `set_frame_ancestors`, `release_lease` and `delete_app` need `write`; all of them need editor or higher.
- **Changes the public sees need the user's explicit yes** (NSO-440): `unpublish`, `delete_app` and `set_visibility` to `public` on a password-protected app answer `user_confirmation_required` until called with `user_confirmed: true`.
- **An app password never passes through MCP** (NSO-440): `set_visibility` with `password` only keeps a password the owner already set in the dashboard. Otherwise it answers the new `password_not_set` error, which carries the app's Settings link (`settings_url`).
- **`release_lease` frees only the caller's own write lease** (NSO-440): Another member's agent can then write at once. A lease someone else holds stays in place (`app_locked`).
- **`get_app` now returns the app's `visibility` and `frame_ancestors`** (NSO-440): The llms-full scope list now also names the proxy-upstream tools.
- **An agent changes an app's stored data over MCP, like the dashboard's Data tab** (NSO-441): Five new tools need the `write` scope and an editor+ role: `create_records`, `update_record`, `delete_record`, `delete_collection` and `purge_orphan_records`. They act as the app's owner, so the collection's rules do not apply, but they go through the data module's own checks: schema validation, record size and the app's quotas (DATA_MAX_DOCS_PER_APP, DATA_MAX_BYTES_PER_APP). Like the CSV import, they skip the per-app write rate limit. Every change is in the audit log with the agent as the actor. On a taken-down app each tool answers `app_locked_by_admin`.
- **`create_records` stores up to 500 records in one call, all or nothing** (NSO-441): A record the schema refuses answers `invalid_params` with its `index` and `issues`. A batch that would go past a quota answers `limit_exceeded` with the limit's name. In both cases nothing is stored. Records added this way have no `_owner`, the same as a CSV import.
- **`update_record` merges the fields by default** (NSO-441): `replace: true` makes the record's own fields exactly the ones sent, which is what the dashboard's editor does. `_owner` and `_created_at` never change.
- **Deleting a collection or purging orphan records needs the user's explicit yes** (NSO-441): Without `user_confirmed: true`, `delete_collection` answers `user_confirmation_required` with the record count. `purge_orphan_records` answers the same way and lists the orphan collections it would delete. `delete_collection` also takes the app's single-writer lease, like `configure_module`.
- **The Activity view shows records added over MCP** (NSO-441): The new audit action is `data.record_create` ("Added N records to <collection>"). A collection deleted or orphans purged through an agent's confirmed call is now recorded with the agent as the actor, not as the user.
- **The agent works the owner's Forms, Users and Uploads tabs over MCP** (NSO-442): It uses the same module bindings, role floors and audit rows as the dashboard. `list_form_submissions`, `list_end_users` and `list_uploads` need the viewer role. `delete_form_submission`, `set_end_user_role`, `set_end_user_blocked` and `delete_upload` need the editor role. `sign_out_end_users` acts only with `user_confirmed: true`. Each change is audited with the agent as the actor.
- **The agent reads the workspace's activity log** (NSO-442): `list_activity` (workspace admins only) returns the audit trail, filtered by app, action, actor kind and a UTC day range, with its context redacted as on the Activity page.
- **End users' personal data reaches the agent only inside the untrusted envelope** (NSO-442): The four list tools answer only envelope text, without structuredContent: at most 100 entries and 64 KiB per call, with `cut` / `clipped` and `next_cursor`. The tools that change an entry answer ids, roles and states, never an address.
- **The agent can remove a module secret by name** (NSO-442): `remove_module_secret` needs the editor role and `user_confirmed: true`, and is audited `module.secret_remove`. A value is still set only in the dashboard. No tool sets or reads one, and `get_app` still shows only `hasSecret`.
- **Agents can create team workspaces and invite members** (NSO-443): `create_workspace` (scope `write`, any signed-in user) creates a team workspace and makes the caller its workspace-admin. It applies the same name and slug rules as the dashboard's New team form; a taken slug answers `slug_taken`. `invite_member` (scope `write`, workspace-admin of a team workspace) e-mails an invite as viewer, editor or workspace-admin, and only with `user_confirmed: true`. It runs the same checks as the dashboard's Invite page and is audited `member.invite` with the agent as the actor. The invite link is never returned to the agent. If the e-mail cannot be sent, the invite is withdrawn and the tool answers `unavailable`.
- **A super-admin's agent can switch opt-in modules and moderate apps** (NSO-443): Four new tools sit next to `set_workspace_publishing` and appear only in a super-admin's tools list: `set_workspace_module` (the Workspace → Modules switch, scope `write`), and `takedown_app`, `restore_app` and `set_gallery_hidden` (the moderation queue's Take down, Restore and Hide / Show, scope `publish`). Every change needs `user_confirmed: true`, and a call that would change nothing answers `changed: false`. Owners get the same takedown and restore e-mails as from the dashboard, and the audit rows name the agent. The moderation tools find an app by its id, its slug or the address named in an abuse report. A new tool error, `module_requires_not_enabled`, lists the modules that must be enabled first.
- **Workspace admins can manage their team's members** (NSO-430): On the Members tab an admin can change a member's role and remove a member. A removed member loses access at once, both in the dashboard and over MCP, and the app edit locks they held are released. The tab also lists pending invites and lets the admin revoke them. Any member can leave a team workspace. A workspace always keeps a workspace-admin, and the membership of a personal workspace never changes. Each action writes an audit row: `member.role_change`, `member.remove`, `member.leave` or `member.invite_revoke`.
- **Agents get three new tools: `list_members`, `set_member_role` and `remove_member`** (NSO-430): Listing members needs the read scope and any role in the workspace. Changing a role or removing a member needs the write scope and the workspace-admin role. Any member can leave by passing their own e-mail to `remove_member`. Removing a member needs `user_confirmed: true`. Two new error codes: `personal_workspace` and `last_workspace_admin`.
- **Workspace admins can delete a team workspace** (NSO-431): A team workspace could not be deleted at all. A workspace-admin now deletes it on the workspace's Delete page (`/workspaces/<slug>/delete`) after typing its slug, or the agent calls the new MCP tool `delete_workspace` (scope `write`, workspace-admin) with `user_confirmed: true` after the user's explicit yes (without it: `user_confirmation_required` with the counts of apps, published apps, members, pending invites and upstreams; nothing changes). Every app, published or not, is deleted and purged at once like the `APP_PURGE_AFTER_DAYS` purge (versions, data, uploads, custom domains), and the memberships, pending invites, upstreams with their keys and module opt-ins go with the workspace. A personal workspace answers `personal_workspace`: it goes only with its owner's account. Audited `workspace.delete`, in the workspace's own trail and in the deleting admin's personal workspace.
- **Users can delete their account** (NSO-431): There was no way to delete an account. A user deletes theirs on `/me/delete` after a fresh code e-mailed to their address (its own OTP scope with the sign-in code's guess and send limits); it is dashboard-only, like API keys and OAuth connections, and `docs/AGENT.md` says so. The personal workspace and every team workspace the user is the last member of are deleted the same way, the other teams are left (their edit locks released, `member.leave` with `reason: account_deleted`), and the account's API keys, OAuth codes and tokens and every dashboard session end at once. It is refused while the user is the only workspace-admin of a team other members use, and the page says to hand the role over on the Members tab or delete the workspace first. A member who joins one of the teams being deleted during the deletion stops it (`workspaces_changed`) and keeps the team: the members are counted again before each app is deleted or purged and under the workspace row lock. Audited `account.delete`.
- **History and audit rows outlive a deleted account or workspace** (NSO-431): Migration 0034 sets `app_versions.created_by_user_id`, `audit_log.actor_user_id` and `upstreams.created_by` to `ON DELETE SET NULL` and drops the foreign key on `audit_log.workspace_id`, so versions, upstreams and audit rows stay without their author, and a deleted workspace's audit trail stays until `AUDIT_RETENTION_DAYS` removes it.
- **Change the sign-in e-mail of an account** (NSO-432): On `/me` (Account → Sign-in e-mail) a user enters a new address, types the code e-mailed to that address, and from then on signs in with it. The previous address gets a notice with the new address masked. Every other dashboard session ends, and this browser stays signed in. API keys, agent (OAuth) connections, workspaces and a linked Google sign-in keep working. The previous address now opens a new, empty account. Sending the code obeys the sign-in code limits (`OTP_*`), counted under their own scope. Audited as `account.email_change`. This is dashboard-only: no MCP tool changes the address.
- **An address that already has an account is refused without revealing it** (NSO-432): The page answers exactly as it does for a sent code. That mailbox gets an "already has an account" e-mail instead of a code, so only its owner learns the account exists.
- **`SUPERADMIN_EMAIL` follows the address** (NSO-432): A user who changes their sign-in e-mail to a listed address becomes super-admin; one who changes it away from a listed address stops being one. The audit row records `super_admin: gained | lost`. The same holds for a workspace editor's admin role in the sign-in of the workspace's apps (platform module `auth`).
- **A deleted app is now deleted for good after `APP_PURGE_AFTER_DAYS` (default 30)** (NSO-429): A server job runs every `APP_PURGE_INTERVAL_MS` (default 1 h) under a Redis lease. It deletes the app row, and everything that references it goes too: versions and their file lists (the blob GC frees blobs nothing else uses), module configs and secrets, custom domains, asset rows and the asset directory, gallery likes and opens, browser errors, compile and request stats, data records, form submissions, end users with their identities and Redis sessions, sync state, and uploads (the files sweep unlinks their blobs). Abuse reports and apps duplicated from the deleted app keep their rows without the reference. The app is also removed from every upstream's allowed apps. Audit entries stay until `AUDIT_RETENTION_DAYS`, and the purge itself is audited as the system action `app.purge`, shown in the workspace Activity. The delete form and the apps list now say what goes for good and when. Migration 0033 makes the `app_versions`, `app_errors` and `app_daily_stats` foreign keys `ON DELETE CASCADE`. An app held by a module table whose reference to `apps(id)` has no `ON DELETE` is logged and retried on every run.
- **The version history has a retention** (NSO-424): An hourly job, which takes a Redis lease, deletes the versions of an app beyond `APP_VERSIONS_KEEP` (default 200). It never deletes the published version, the newest compiled version (the one the preview serves), a version whose asset set is kept for a rollback, or a version from the last hour. The existing blob GC then frees the bytes. The limits provider can override the number per workspace. Each run that deletes versions is recorded in the workspace Activity ("The history retention deleted 12 old versions (versions 1–14)"). The dashboard's version history and `get_app` (`version_retention: { keep_newest, stored, oldest_version }`) show what is kept.
- **A version the retention deleted answers clearly** (NSO-424): `read_file`, `restore_version` and `publish` of such a version answer `not_found`, saying the retention deleted it, how many versions an app keeps, and which is the oldest version still stored. Its Files page in the dashboard is a 404.
- **Each workspace has a source quota** (NSO-424): The versions of all apps in a workspace may store `WORKSPACE_SOURCE_QUOTA` bytes of unique files, sources and build output (default 1 GiB, which the limits provider can override). A write, `create_app` or `duplicate_app` whose new bytes do not fit answers `limit_exceeded` with `limit: "WORKSPACE_SOURCE_QUOTA"`, `value` and `used_bytes`, and stores nothing; no empty app is left behind. A restore adds no bytes and is never refused. Deleting an app frees its share at once. The agent briefing states both limits.
- **New versions are rate-limited per app and per person** (NSO-423): `write_files`, `create_app`, `restore_version`, `duplicate_app` and the dashboard's Restore and duplicate page refuse a new version once the app got `VERSIONS_PER_APP_HOUR` (default 600) new versions, or the person made `VERSIONS_PER_USER_HOUR` (default 1200, across all apps and workspaces), within the last hour. The refusal is `rate_limited` with `limit`, `value` and `retry_after_seconds`; the dashboard answers 429 with `Retry-After`. Nothing is stored, so a loop of writes can no longer fill the database. Both are core limits that a limits provider may set per workspace. The briefing, the `limits` list, the error catalogue and the skills state them.
- **Migration 0036 indexes `app_versions` by creator and time** (NSO-423): (`app_versions_creator_created_idx`) for the per-person version count. The server applies it on start.
- **Request bodies of the dashboard, the sign-in and the OAuth endpoints are capped** (NSO-425): React Router actions read their whole body into memory with no limit, and `/login`, `/oauth/token`, `/oauth/register` and the abuse report did so before any sign-in. A chunked upload had no declared length to check at all. A body over the new `DASHBOARD_MAX_BODY_BYTES` (default 1 MiB) now answers `413 {"error":"payload_too_large",…}` before the route runs. A declared length is refused before anything is read, and a chunked body is refused as soon as the bytes that arrived pass the cap. The connection closes after the answer and the server keeps serving. `/mcp` (`MCP_MAX_BODY_BYTES`), the asset upload URLs and the Data tab's CSV import keep their own limits. The CSV import now also counts a chunked body against its 10 MiB file limit instead of only checking the declared length, and still answers on the page.
- **The generated Caddyfile refuses oversized dashboard request bodies** (NSO-425): The dashboard site now has `request_body` with `max_size` set to `DASHBOARD_MAX_BODY_BYTES`, so Caddy answers 413 before the body reaches drobek. `/mcp`, the asset upload URLs and the Data tab's collection pages are left to drobek's own limits. After upgrading, or after changing the variable, render the Caddyfile again with `task selfhost:init` and run `task tls:reload` (`task caddy:config` in a development checkout).
- **MCP sessions are closed when idle, past a per-user cap and on revocation** (NSO-427): Until now every `initialize` kept its MCP server and transport in memory until the client sent `DELETE`, so a client that never ended its sessions held memory for good. A session with no request open for `MCP_SESSION_IDLE_TTL_MS` (default 1 hour; an open listen stream counts as a request) is now closed. When a user opens more than `MCP_SESSIONS_PER_USER` (default 10), their least recently used session is closed. Revoking an API key or an OAuth connection, or a refresh-reuse detection, closes that credential's sessions at once. Before, its requests only got 401 and the session stayed open. A request with a closed session's id answers `404 MCP session not found — reconnect.`, and per the MCP specification the client then opens a new session. Each closing writes an `mcp session closed` log line with the reason (`idle`, `limit` or `revoked`), the short session id and the user id. A session is now also bound to the grant that opened it (the API key, or the OAuth client, so it survives token refreshes): a different credential of the same user gets 401 on it.
- **An error nothing caught now stops drobek gracefully** (NSO-428): If an `uncaughtException` or `unhandledRejection` occurs, drobek logs it with the log-safe DB summary and sends it to the error reporter as `kind: 'process'`, `level: 'fatal'`. It then runs the same drain as on `SIGTERM` and exits with code 1 after the report has been delivered or has timed out. Docker's `restart: unless-stopped` starts it again. Before this, the process died without draining the requests in flight and without a report.
- **Database pool size and query timeouts are now operator settings** (NSO-428): Operators get three new variables: `DB_POOL_MAX` (20), `DB_STATEMENT_TIMEOUT_MS` (30 s) and `DB_LOCK_TIMEOUT_MS` (10 s, `0` = none); an invalid value stops the server at start. Requests use a pool with both timeouts. Background jobs use a pool of their own with only the lock timeout. Migrations keep their own connection with no timeout. A stuck query or a long `FOR UPDATE` wait can no longer tie up the connections every other request needs. The dashboard's bundled server build now shares the same pools, so `DB_POOL_MAX` is the limit for the whole process: at most 2 × `DB_POOL_MAX` connections.
- **A query cut off by a timeout returns a catalogue error** (NSO-428): Agents get `busy` with `reason: "database_timeout"` from any MCP tool and from the asset upload URL (503). Module routes answer `503 unavailable` with `details.reason: database_timeout` and `Retry-After`. App hosts answer a plain 503. The log shows `db error 57014` / `55P03`, never the driver's message.
- **SMTP sends time out** (NSO-419): New env vars `SMTP_CONNECTION_TIMEOUT_MS` (default 10000), `SMTP_GREETING_TIMEOUT_MS` (default 10000) and `SMTP_SOCKET_TIMEOUT_MS` (default 30000) replace nodemailer's own 2 min / 30 s / 10 min. Allowed range is 1000–120000; the server refuses to start on an invalid value. A hung mail server now fails the send within seconds, and the sign-in form shows its 'could not send' message. The vars are listed in `.env.example`, `.env.production.example` and the SELF-HOSTING env reference.
- **Expired OAuth rows, old gallery opens and resolved abuse reports are pruned daily** (NSO-433): A new retention job runs when the server starts and then once a day, under a Redis lease. It deletes OAuth access and refresh tokens 7 days after they expire, and authorization codes 37 days after they expire (by then the lineage a code minted has expired as well). Refresh-token reuse detection still sees every rotated token until that token expires, and replaying a code still revokes its lineage for as long as the lineage exists. The job also deletes `gallery_opens` days older than the 30-day `opens` window plus 7 days, and abuse reports that were resolved more than `ABUSE_REPORTS_RETENTION_DAYS` days ago (new, default 365). Open reports always stay. The resolved view of the super-admin abuse queue now shows this retention period.
- **An image older than the database refuses to start** (NSO-434): Drizzle's migrator only compares the newest applied migration with the image's journal, so an older image on a newer database used to apply nothing and serve against a schema it did not know. Now the server start and `task selfhost:migrate` stop with a message when a journal (core or module) holds migrations the image does not know. The message names the drobek release to run, and for a module journal also the module version. Every successful run records, per journal, the image and module version that brought the journal's newest migration in `drizzle.__drobek_migration_images`. In `task selfhost:upgrade` a pinned `DROBEK_IMAGE_TAG` that is too old now stops the upgrade at the migrate step, before anything starts serving.
- **Migrations run under a Postgres advisory lock** (NSO-434): The server start, `task selfhost:migrate` and every module journal take one lock (`hashtext('drobek:migrations')`). When two replicas start together, the second one logs `waiting for another drobek process to finish its migrations`, waits, finds everything applied and starts. Before, both could run the same migrations at the same time.
- **`DROBEK_MASTER_KEY` can be rotated** (NSO-435): Operator: put the old key in the new `DROBEK_MASTER_KEY_PREVIOUS` and the new key in `DROBEK_MASTER_KEY`, then recreate drobek and run `task selfhost:rekey`. Secrets stored under the old key can still be read in the meantime, and new ones use the new key. `task selfhost:rekey` re-wraps every stored upstream and module secret under the new key without decrypting any value. It prints counts per table, can be run again safely, and can run while drobek is serving. Remove `DROBEK_MASTER_KEY_PREVIOUS` afterwards. `docs/SELF-HOSTING.md` ("Rotating DROBEK_MASTER_KEY") describes the procedure and what a rotation ends: password-gate cookies, open forms tokens, provider sign-ins in progress, stored IP hashes, and the key fingerprint of older backups.
- **A production start refuses stored secrets that no key of the server can open** (NSO-435): If the database holds upstream or module secrets under neither `DROBEK_MASTER_KEY` nor `DROBEK_MASTER_KEY_PREVIOUS`, drobek stops and says how many there are and how to fix it. Outside production this is a warning. If the old key is lost, `task selfhost:rekey FORGET_UNKNOWN=1` deletes those secrets and names each one (`<workspace>/<upstream>`, `<workspace>/<app> <module>.<NAME>`) so the owners can set them again. A malformed `DROBEK_MASTER_KEY_PREVIOUS` stops the start, `task selfhost:migrate` and the rekey.
- **`task restore` handles key rotation** (NSO-435): It accepts a backup made under `DROBEK_MASTER_KEY_PREVIOUS` and afterwards tells you to run `task selfhost:rekey`. With `ALLOW_KEY_MISMATCH=1` it now deletes the secrets that can't be decrypted before starting the stack, because the start would otherwise refuse them.
- **`task backup` keeps the newest 14 archives and no longer fills the disk** (NSO-436): `task backup` only ever added archives to `backups/` on the data disk, so the daily cron and every `task selfhost:upgrade` filled it over time. Once a backup's archive verifies, every `drobek-<UTC timestamp>.tar.gz` in `BACKUP_DIR` beyond the newest `BACKUP_KEEP` is deleted (default 14; `0` keeps every archive). A failed backup deletes nothing, and files with any other name are never touched. **The first backup after the upgrade, including the one `task selfhost:upgrade` takes, deletes all but the newest 14 archives. Copy older archives off the machine first, or set `BACKUP_KEEP=0` in `.env.production`.** Before it writes anything, the backup estimates the size of the parts (the database's tables plus the four volumes). It refuses to start unless `BACKUP_DIR` has twice that plus `BACKUP_MIN_FREE_MB` (default 1024) free; the error gives the sizes, the archives already there and what to do. The refusal also stops an upgrade before anything changes. The parts are now written to a hidden directory inside `BACKUP_DIR` instead of `/tmp`. `BACKUP_DIR`, `BACKUP_KEEP` and `BACKUP_MIN_FREE_MB` come from the environment (`task backup BACKUP_KEEP=30`), else from `.env.production`.
- **`task backup:verify` checks an archive without restoring it** (NSO-436): It reads `manifest.json` and `SHA256SUMS` and checks that both list the same parts with the same checksums and that every part a restore needs is there. It then streams each part out of the archive and compares its size and sha256. Nothing is unpacked and neither docker nor the stack is needed, so a copy on another machine checks the same way. It checks the newest archive in `BACKUP_DIR` by default (`BACKUP=` picks another) and exits 1 naming the first damaged part. It also says whether the `DROBEK_MASTER_KEY` (or `DROBEK_MASTER_KEY_PREVIOUS`) in `.env.production` is the key the archive was made with. `task backup` runs the same check on every new archive before it deletes older ones.
- **Production container logs rotate** (NSO-436): `docker-compose.production.yaml` set no log limit, so container logs grew without bound. Every service now uses the `json-file` log driver with `max-size` `CONTAINER_LOG_MAX_SIZE` (default `20m`) and `max-file` `CONTAINER_LOG_MAX_FILES` (default 5), at most 100 MB per service. The limits apply when a container is recreated (`task selfhost:upgrade` or `docker compose … up -d`).

### Changed
- **CI now runs the e2e specs the image flow used to skip** (NSO-444): `task e2e:image` (the CI `e2e` job) signs in through a company OpenID Connect IdP, verifies and serves a custom domain over real DNS, trips the per-IP limit on unknown app hosts, sends mail through a module's e-mail transport and publishes under `PUBLISH_APPROVAL=approval`, all against the production image and in the same job. A second phase recreates drobek with `EMAIL_TRANSPORT=relay` and `PUBLISH_APPROVAL=approval`. The e2e stack gains a mock IdP behind its Caddy over https (the server's `AUTH_OIDC_ISSUER`) and a mock DNS server (`DOMAINS_DNS_SERVERS`). Contributors only; nothing changes for operators or app owners.
- **Every `task e2e:image` run ends with a skip check** (NSO-444): `scripts/e2e-skip-guard.mjs` fails the run when a test of the suite ran in no phase, and names each such test with the skip reason every phase gave, so a test that needs a configuration CI does not provide can no longer pass silently.
- **A release tag passes a release gate before it is published** (NSO-445): On every `vX.Y.Z` tag, CI now runs three more checks: an audit of the production dependencies in the lockfile, a vulnerability scan of the image being released (operating-system and Node packages), and the self-host rehearsal (the quickstart, `task backup` and a restore on a second machine) against the pushed image. A high or critical finding, or a failed rehearsal, stops `promote`. The image scan counts only a finding that has a fixed version. When `promote` stops, `latest` stays where it was and no GitHub Release, npm packages or MCP Registry entry is published. None of the checks runs on a push to `main` or on a pull request. `docs/SELF-HOSTING.md` → Image tags lists what the gate checks.
- **The docs no longer count the MCP tools, and the briefing says that types are checked** (NSO-422): `docs/ARCHITECTURE.md` and the README named a number of tools that went stale with every new tool; they now point at the list. The briefing, the `start` and `drobek` skills and the `compile_error` fix said TypeScript types are "stripped, not checked", although a version that compiled is type-checked in the background; they now say so. `CLAUDE.md` rule 6: own work is consolidated on `main` without pull requests.

### Fixed
- **A deleted app no longer keeps its custom domain** (NSO-418): Before, a domain verified for an app stayed reserved after that app was deleted, so no other app could add or verify the name. Now the name is free as soon as the app is deleted. Any app, in the same workspace or another one, can add it and verify it with its own TXT and CNAME records. `domain_taken` now means only that a live app has verified the name. This also applies to apps deleted before this release, and no migration or cleanup is needed. As before, Caddy's TLS `ask` gives no certificate for a deleted app's domain, and the domain stops serving when the app is deleted.
- **A mail outage no longer locks an address out of dashboard sign-in** (NSO-419): Before, a failed send of a sign-in code still counted against the address's hourly share (`OTP_EMAIL_HOURLY_LIMIT`, 3 by default) and the global brake (`OTP_GLOBAL_HOURLY_MAX`). After a few failures, the next request redirected to `/login/verify` as if a code had gone out, and the address stayed locked for an hour. Now only codes that went out count there. A failed send counts only against the per-IP windows (`OTP_IP_SHORT_LIMIT` / `OTP_IP_DAILY_LIMIT`, which count every request), so the next request after mail recovers sends a code. `@drobek/auth`: `guardOtpRequest` reads the per-address and global counters, and the new `chargeOtpSent` charges them after a successful send. End-user sign-in in the platform `auth` module already charged only sent codes (`checkOtpRequest` / `chargeOtpRequest`); a test now covers a transport outage there too.
- **A rate-limit counter can no longer lock a key forever** (NSO-420): A counter is now created together with its expiry in one Redis transaction (`SET 0 PX NX` + `INCR` + `PTTL` in one MULTI). A counter found without an expiry, for example one left by a crash between the old INCR and PEXPIRE, gets its window back on its next hit or check. Before this, such a key on the hourly sign-in brake (`otp-global-1h:all`) stopped every dashboard sign-in until an operator deleted it by hand. The dashboard and app end-user sign-in, every `rateLimitRedis` bucket, module route limits and the asset upload-URL budget all use the new counter, and existing stuck keys repair themselves. Limits and windows are unchanged.
- **Malformed HTML or CSS in one file no longer stalls the whole instance** (NSO-421, #87): Some scans used regular expressions that took quadratic time on unclosed tags, attributes or comments, or on an unterminated CSS `url(`. Affected were the compile's reference warnings (`missing_reference`, `blocked_by_csp`), the readiness checks (`write_files`, `publish`, `get_app`, the dashboard's "Before you publish") and the publish heuristic. One 512 KiB file took seconds to minutes, and the scans run on the one Node process, so meanwhile no request of any workspace got an answer. Each scan now reads a file once from left to right: 512 KiB of any such input takes milliseconds, and the scan finds what it found before. Two results change, both on input a browser refuses or that is not a domain: an unquoted CSS `url(` ends at an unescaped `(`, and the heuristic reads a domain glued to a leading `_` as words.
- **The publish heuristic no longer skips a version with a very large script** (NSO-421, #87): A script with more than about 120,000 string literals made the scan throw. The publish went through without the check and without a report. Such a version is now scanned like any other.
- **App hosts keep a bounded cache, and a version that does not exist is counted** (NSO-426): Requests for `<slug>--v1` … `--v999999999` of a live app no longer grow the server process or cost a database lookup per number. The host-resolution cache holds at most 20 000 hosts across all apps, and expired entries are dropped. Missing versions go to the separate 30 s negative cache. A version host whose version does not exist or did not compile now counts toward `APPS_UNKNOWN_HOST_LIMIT` and answers 429 once the limit is reached. A throttled client is answered without a lookup unless the cache already knows that exact version.
- **On-demand TLS no longer issues certificates for version numbers an app does not have** (NSO-426): Caddy's `ask` now answers 200 for `<slug>--v<N>` only when version N of the live app exists and compiled. Every other number gets 404, so nobody can use up the CA's quota for `APPS_DOMAIN` by walking version numbers. The comment in the generated Caddyfile changes: operators in on-demand mode see a one-comment diff after `task selfhost:init`, and no action is needed.
- **A second change that needs confirmation no longer replaces the first** (NSO-439): When `configure_module` (or a save in the dashboard's module page) proposes a change while another one is still waiting for the owner, the new change is now added to the waiting one. Before this, the new change replaced the waiting one, so the owner confirmed only the newer change and the earlier one was lost without warning. The combined change is checked as a whole. `pending_confirmation` is worked out again against the config in force, so a part the newer change undoes drops out of it. If either part needs a workspace admin, the combined change does too. The answer and the `module.pending` audit row now include `merged_with_pending`, which lists the changes that were already waiting, and the tool's note tells the agent that the user confirms or rejects everything at once. On the module page the owner sees one before → after diff: Confirm applies all of it and Reject drops all of it. A save that joins a waiting change shows its own notice. A proposal that does not fit the waiting change returns `invalid_params` with the issues and the waiting changes, and nothing is stored.
- **A Redis restart no longer shrinks a day of request stats** (NSO-433): When the request counters are written to `app_daily_stats`, each count keeps the larger of the stored value and the value from Redis. This covers requests, 5xx and each path's 404 count. Before, a flush after Redis lost its counters replaced the stored day with the smaller totals.

## v0.7.4 — 2026-10-02

### Added
- **Readiness warns about a missing description, a missing favicon and a link-preview image that is not an absolute URL** (NSO-415): apps went live without a meta description, a favicon or a usable link preview, because nothing pointed the agent at them. `write_files`, `publish`, `get_app` and the dashboard's "Before you publish" now list `missing_description` (index.html has no, or an empty, `<meta name="description">` in its head), `missing_favicon` (no `<link rel="icon">` in its head and no `favicon.ico` in the version; an uploaded favicon.ico counts once index.html links it) and `og_image_not_absolute` (an `og:image` / `twitter:image` of any page that is not an absolute `https://` URL, which link previews ignore), each with its fix. They are warnings: nothing is blocked, and drobek adds nothing to an app's pages. An app fresh from a template has the first two until the agent adds them.
- **The briefing and the skills cover the browser tab, search results and shared links** (NSO-415): a new briefing section, the `start` and `drobek` skills and pointers in `port-artifact` and `ui` tell the agent to write the title and the description, a favicon (an SVG with `write_files`, a PNG or ICO with `create_asset_upload`), the Open Graph and Twitter tags with `og:url` and `og:image` as absolute https URLs on the production address (a ~1200×630 PNG or JPEG upload, never SVG — or no image at all), and how search engines see the app: the preview and version hosts are `noindex`, `<meta name="robots" content="noindex">` keeps an app out of search results, and drobek serves no robots.txt of its own.

### Changed
- **CI builds the production image in its own job** (NSO-416): the e2e job built the image, ran the suite against it and pushed it within one 10-minute limit, and a slow runner cancelled it during the push. A new `image` job builds the image and hands it to the e2e job as a workflow artifact (kept for a day); the e2e job loads it, runs the suite and pushes the image it tested. Both keep the 10-minute limit.
- **The README and the MCP Registry entry describe drobek as open-source vibe coding hosting** (NSO-417): the README names it as a self-hostable alternative to Lovable, Bolt.new and v0 for people who already use an agent, and says a Claude artifact moves over unchanged.

## v0.7.3 — 2026-10-01

### Fixed
- **A refresh retried within 60 s gets a fresh pair; reuse revokes only its own lineage** (NSO-414): presenting a refresh token that had already been rotated was always reuse, and reuse revoked every access token of that user for the client and audience. Claude Code retries a refresh with the same token after a timeout or a lost response, its sessions on one machine share the stored token, and its `client_id` is one CIMD URL for every install — so one innocent retry answered `invalid_grant` and signed the user out of Claude Code on every machine. Now a rotated refresh token sent again within 60 s of its rotation (and of every later rotation in its chain, at most 10 links) is a retry: the lineage's newest, unused token is rotated and the client gets a fresh pair. Later it is reuse as before, but it revokes that lineage only: its refresh tokens are marked used and the access tokens issued with them revoked (migration 0032 adds `oauth_access_tokens.refresh_token_id`; access tokens issued before it are revoked by user, client and audience), so the user's other connections of the same client keep working; a replayed authorization code revokes the same way. A rotation now claims the token and links its successor in one transaction. Every refresh logs one `oauth refresh` line with its outcome (`rotated`, `retried`, `unknown`, `expired`, `client_mismatch`, `reuse`) and row ids, never a token.
- **Restarts and deploys no longer cut requests in flight** (NSO-414): on `SIGTERM` the server closed its listener without waiting and exited as soon as its background jobs stopped, so every deploy or restart cut a `write_files` compile, a token refresh or any other request it was answering, and the MCP listen streams with them. It now ends the MCP listen streams (a new `GET /mcp` on the stopping server answers 405), closes idle connections, lets requests in flight finish for up to the new `SHUTDOWN_GRACE_MS` (default 20000), cuts what is still running after that, then stops its jobs and exits; the production compose gives the container `stop_grace_period: 30s`. Idle connections now stay open 125 s, longer than Caddy's 2-minute upstream keep-alive: with Node's 5 s default Caddy could reuse a connection Node was closing and answer a POST with 502. MCP sessions still live in the process: after a restart a client's old session id answers 404 and the client opens a new session.
- **A large `write_files` call answers a JSON-RPC error instead of breaking the connection** (NSO-414): `/mcp` took at most 512 KB per request while one version may hold 5 MiB, and a bigger write got the generic plain `413 {"ok":false,"error":"entity_too_large"}`, which MCP clients report as a transport failure. The cap is now the new `MCP_MAX_BODY_BYTES` (default 2 × `COMPILE_MAX_TOTAL_BYTES` = 10 MiB); a request over it answers 413 with a JSON-RPC error (`-32600`) that names the limit and tells the agent to split the write into several calls or send `edits`, and malformed JSON answers 400 with a JSON-RPC parse error (`-32700`). The Bearer is checked before the body is read. The briefing, the limits table of `/llms-full.txt` and the skills state the cap.
- **A failing `/mcp` request answers and is reported** (NSO-414): an error inside the MCP transport was an unhandled promise rejection and the client got no answer; it now answers JSON-RPC `-32603`, is logged and goes to the error reporter (`errors.reporter`).
- **MCP disconnects can be traced in the server log** (NSO-414): `/mcp` left no record of its requests. Each request now logs one `mcp request` line when its response closes: the HTTP method, the JSON-RPC method, the tool of a `tools/call`, the status, the duration (for a listen stream: how long it was open), the first 8 characters of the session id and the user id, plus `aborted: true` when the connection closed before the response finished — never tool arguments, tokens, API keys, headers or bodies.
- **`task module:*` rebuilds the workspace only when its sources changed** (NSO-412): since v0.7.2 `module:add`, `module:example` and `module:fixture` ran `pnpm install` and `pnpm build:packages` on every call. In a running dev stack the rebuilt `packages/*/dist` restarted drobek, and the e2e spec that reinstalls the example module cut the rest of `task e2e` with `ECONNRESET`. The build is now one task fingerprinted on the workspace sources and the lockfile, and the e2e reinstall (`task module:example:install`) does not build.

## v0.7.2 — 2026-10-01

### Fixed
- **Sync runs and module jobs send a User-Agent** (NSO-413): a call the server makes to an upstream itself (a `sync` run, `ctx.upstreams.fetch` of a module job) went out without a `User-Agent`, and APIs that require one refused it: GitHub's API answered every sync run with HTTP 403. The proxy now sends `User-Agent: drobek (+https://github.com/freema/drobek)` when the caller sent none; a browser's own User-Agent passes as before. Found by the sync canary on drobek.app.
- **`task module:example`, `module:fixture` and `module:add` install and build the workspace first** (NSO-412): after a pull they installed a module into the dev stack against stale package builds and `node_modules`, and the stack failed to start; they now run `pnpm install --frozen-lockfile` and `pnpm build:packages` before the install.

## v0.7.1 — 2026-10-01

### Fixed
- **Operator-only modules stay hidden as a slot's contributors** (NSO-412): an operator-only module that contributes to a slot of an app-facing module — an e-mail transport under `email`'s `email.transport` — was still named among that slot's contributors, so `skill_info('email')`, the app's `email` module page and the workspace Modules page showed it to agents, app owners and every member. It is left out there now; only a super-admin's workspace Modules page names it, next to its operator-only card.

### Changed
- **The e2e stacks run an operator-only fixture module** (NSO-412): `tests-e2e/fixtures/drobek-module-ops-probe` (`opsprobe`) is installed into both e2e stacks the way an operator installs a module (`task module:fixture` for `task dev` / `task e2e`, `scripts/e2e-image.sh` for the image flow). It is their error reporter (`ERROR_REPORTER=capture`; reports land on `proxy-echo`, where the specs read them) and the dev stack's e-mail transport (`EMAIL_TRANSPORT=relay`: every message goes to Mailpit over its HTTP API; `EMAIL_TRANSPORT=smtp` sends over SMTP as before). The image flow keeps the built-in SMTP. New specs cover the compile warnings, the scheduled-work briefing, the upstream cap and the hourly registration rate, the `files` and `forms` settings forms, operator-only modules, error reports and a module's e-mail transport.
- **Workspace packages build and typecheck in parallel** (NSO-411, #76): `pnpm build:packages` and `pnpm typecheck` run through `pnpm -r`; unit tests still run one package at a time.

## v0.7.0 — 2026-10-01

### Added
- **Company sign-in with any OpenID Connect provider: the `oidc` module** (NSO-351, #52): a new built-in module (`drobek-module-oidc`, requires `auth`, in the compose default `DROBEK_MODULES`) is the `auth.provider` `oidc` — Google Workspace, Microsoft Entra ID, Okta, Keycloak, Auth0 and any other OpenID Connect IdP, without per-IdP code. It has no config of its own: the AUTH config takes `providers.oidc: { enabled, issuer?, clientId?, scopes, trustEmail, label, claims?, prompt?, relinkByEmail? }`; enabling it and changing `issuer`, `clientId`, `trustEmail` or `claims` wait for the owner. Discovery must name the configured issuer exactly, sign-in uses PKCE S256, state and nonce, the code exchange `client_secret_basic` or `_post`, and the ID token is verified with `node:crypto` (RS256 / ES256 / PS256 from `jwks_uri`, `iss`, `aud` / `azp`, `exp`, `iat`, `nonce`); an unverified address is refused unless `trustEmail`. Every IdP call goes through the proxy's SSRF guard. The client secret is the auth module's per-app secret `OIDC_CLIENT_SECRET`; an operator may run one IdP for every app with `AUTH_OIDC_ISSUER` / `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_CLIENT_SECRET` (that issuer may be private and on any port), and `OIDC_DISCOVERY_CACHE_SEC` (default 3600) caches discovery. The redirect URI to register at the IdP is `<PUBLIC_APP_URL>/__drobek/auth/callback/oidc`. Any sign-in provider whose config declares `label` now shows it on the sign-in page and the error pages, and `get_app`'s auth info lists the providers, whether each is enabled and the env names it falls back on. `skill_info('oidc')`; docs/MODULES.md "The built-in `oidc` module".
- **drobek is listed in the official MCP Registry** (#48): as `io.github.freema/drobek` (`server.json`) with the hosted Streamable HTTP endpoint `https://drobek.app/mcp` (OAuth 2.1). The release pipeline publishes every tag's version there after the image is promoted.
- **An external module end to end: the `acmecrm` example** (NSO-352, #53, #54): `examples/drobek-module-acme-crm` is the scaffold's output grown into an opt-in module (own table and migrations journal, a rule-guarded route, an `auth.signedIn` observer, its own error code, limit and secret, a skill that passes the skill check). `task dev` and `task e2e` install it into `./.modules` with `task module:example` the way an operator installs a module, and the image e2e with `selfhost-module.sh`; the specs cover the directory install and its integrity check, opt-in by plan and the `oidc` sign-in against a local mock IdP (`task mock:oidc`). It is never a dependency of the server and stays out of the image.
- **Compile warnings: broken references and URLs the app CSP blocks** (NSO-402, #28): `compile.warnings` of `write_files` and `create_app` adds `missing_reference` (a literal same-app path — HTML `src`/`href`, icon `<meta>`s, web manifest icons, CSS `url()`/`@import`, a `fetch()`/`new URL()` of a `/path` — to a file the version does not have and that is not an uploaded asset, e.g. a `<link rel="icon" href="/favicon.ico">` without the file) and `blocked_by_csp` (a literal URL of another origin the app CSP refuses — a `fetch()` to an API, a `<script src>`, `import` or `drobek.json` import from a host other than esm.sh, an `http://` image or font), each with file, line, the directive and what it allows, and the fix (a proxy upstream, an esm.sh URL, https, or the file in the app). Computed URLs, `data:`/`blob:`/`mailto:`/`tel:`, anchors, `/__drobek/…`, extension-less paths and the build's own outputs are ignored. The CSP fetch directives now live in one list in `@drobek/compile` that the app hosts build their header from (the header is unchanged). Warnings only — nothing new is refused.
- **Error reporters from modules: the `errors.reporter` slot** (NSO-401): operators choose where server errors go besides the container log. A module contributes `defineErrorReporter({ apiVersion?, id, label, secrets?, report(event, ctx) })` from `@drobek/modules` to the `errors.reporter` slot, which core hosts (no host module needed; `errors` is now a reserved module name), and `ERROR_REPORTER=<id>` selects it — unset keeps today's behaviour (log only). It receives a 5xx of the dashboard or Express, a module route that throws, a failed module job, a failed e-mail send and a start-up failure once it is installed, as `{ level, message, error?, context: { kind, route?, method?, status?, module?, job?, appId?, workspaceId? }, release, environment, timestamp, fingerprint }` — never request bodies, headers, cookies or query strings; e-mail addresses, token-shaped text, the reporter's secrets and the server's own are redacted, and a database error keeps only its code and table. Delivery is fire-and-forget: cut off after the new `ERROR_REPORTER_TIMEOUT_MS` (default 5000), at most `ERROR_REPORTER_MAX_PER_MINUTE` (default 60) reports per minute with an identical error once per minute, and a failing reporter is logged once per minute and dropped. Its secrets are operator env vars it names, read at start and handed over in `ctx.secrets`. The server refuses to start when no active module contributes the id or a declared secret is unset (docs/MODULES.md "Error reporters from modules").
- **E-mail providers as modules: the `email.transport` slot** (NSO-363): the built-in `email` module hosts a slot for other e-mail providers (SES, Postmark, a company relay, …). A module contributes `defineEmailTransport({ apiVersion?, id, label, secrets?, send(msg, ctx) })` from `@drobek/modules` — the same message as the built-in transports (`from`, `to`, `subject`, `text`, `html`, `replyTo?`) and the same `EmailSendError` codes — and `EMAIL_TRANSPORT=<id>` makes it carry all of the server's mail: dashboard sign-in codes, invites, platform notices and every module's `ctx.email.send`. Its secrets are operator env vars it names (`secrets: ['POSTMARK_TOKEN']`), read at start, handed to `send` in `ctx.secrets`, never shown over MCP or logged, and redacted from every error. A send is cut off after the new `EMAIL_TRANSPORT_TIMEOUT_MS` (default 10000). The server refuses to start when no active module contributes the id, a declared secret is unset, or a contribution takes `smtp` or `resend`, which stay built in and behave as before; the rate limits above the transport are unchanged (docs/MODULES.md "E-mail transports from modules").

### Changed
- **The self-host quickstart is measured on a clean Ubuntu 24.04 host** (NSO-304, #49, #50, #51): the manual `selfhost-rehearsal.yml` workflow pulls a released image on a fresh `ubuntu-24.04` runner and runs `task selfhost:rehearsal` (the docs/SELF-HOSTING.md quickstart, `task backup` and a restore on a second machine) with the timings in the job summary. docs/SELF-HOSTING.md's "Measured" line now comes from it: with `v0.6.1`, image pull 8 s, quickstart 31 s, backup 3 s, restore 25 s. The rehearsal reads a file's mode with GNU `stat` first.
- **Operator-only modules need no skill** (NSO-408): a module that only serves the server itself — an error reporter, an e-mail transport — may leave out `skill`, as long as nothing of it reaches apps: no routes, SDK, app config (its `configSchema` is `z.object({})`; no `salvageConfig` / `confirmRequired` / `onConfirmed`), per-app secrets, rules, own error codes, owner authority, `appInfo`, `availability: 'opt-in'`, `dashboard.editor`, `scope: 'app'` job, `compose`, and only slots marked with the new `ModuleSlot.operatorOnly: true` — the core-hosted `errors.reporter` and the `email` module's `email.transport` are; `auth.provider`, `auth.signedIn` are not. Limits, migrations, hooks, `requires`, server jobs and `dashboard.title` stay allowed. `defineModule` types such a module as the new `OperatorModule` (`DrobekModule` keeps `skill` required; `AnyModule` is either). A module without a skill that has any app surface refuses the start naming it (`module "x": skill is required: the module reaches apps through routes, secrets — …`, or `module "x" has no skill, but contributes to the slot "auth.provider" (module "auth"), which reaches apps — …`). Such a module is left out of `skill_info()` (and `skill_info('<name>')` answers `not_found` like an unknown name), the briefing, `/llms.txt` / `/llms-full.txt`, `create_app` / `get_app` `skills` and `modules`, `configure_module`, its `/__drobek/v1/<name>/…`, the app's Modules tab and module page, and the workspace Modules page for everyone but super-admins, who see it marked operator-only; `/healthz`, `/api/version` and the start log add `operatorOnly: true` to it. Additive: every module with a skill loads and shows exactly as before, and `MODULE_CONTRACT_VERSION` stays `1.2.0` (a server that predates this refuses a module without a skill). docs/MODULES.md "Operator-only modules".
- **Module config fields that name existing things are selects; sync reads as "Scheduled imports"** (NSO-406): a string field of a module's `configSchema` may carry `x-drobek-choices: 'upstreams' | 'collections' | 'intervals'` (zod `.meta()`, typed by the new `ConfigFieldMeta` / `ConfigChoices` from `@drobek/modules`), and the dashboard's config form renders it as a select: the workspace's upstreams (those assigned to the app first, with a link to where an upstream is assigned), the app's data collections, or intervals from 5 minutes to a day no shorter than the module limit `x-drobek-min-interval` names. A current value that is not among the choices stays selected and is marked; with nothing to choose the form says what to set up first and links there instead of showing an empty select; a list that fails to load leaves a text field with a note. The annotation is presentation only — `configure_module` and the dashboard's save validate exactly as before. The `sync` form uses it for the upstream, the collection and the schedule (a custom `every` is kept), and every sync field has a label and a hint (`items` and `key` say when they are needed). A module may declare `dashboard.title` and `dashboard.description` (one line each, 60 / 200 characters at most): the dashboard shows `sync` as "Scheduled imports (sync)" with a cron-like description on the app's Modules tab, the module page and the workspace Modules page (whose search also matches them); the identifier `sync` is unchanged everywhere else. Across the module forms: the empty option of a select names the default ("Default (1h)") or reads "Choose…" for a required field, and a record's entry name is labelled by its key schema's `title` ("Form name" in `forms`, "Source name" in `sync`). docs/MODULES.md "Choices of a config field".
- **The remaining module forms read as settings** (NSO-409): `files` asks who may upload and who may download with the same principal checkboxes as the collections editor (Anyone, Signed-in users, Record owner, App admins; nothing checked is `none`) instead of rule text, and takes the largest file in MB (stored in bytes as before) with this workspace's `FILES_MAX_BYTES` named as what an empty field means; a sign-in provider of the `auth` form (`oidc`) leads with its On switch; the `sync` form no longer shows a Paused checkbox next to Pause / Resume and a save keeps the pause; a new entry of the `forms` form suggests the names of forms that received submissions but have no settings yet. New `ConfigFieldMeta` keywords do it for any module: `x-drobek-rule` (`true` or the principals offered), `x-drobek-unit: 'bytes'`, `x-drobek-default-limit`, `x-drobek-hidden`, `x-drobek-order` (an object's keys shown first), and the `x-drobek-choices` source `forms` (on a record's key schema the choices suggest a new entry's name). Presentation only: `configure_module` and the dashboard's save validate as before, and a field saved untouched keeps its exact value (a rule written `admin|user`, 5000000 bytes). docs/MODULES.md "How a config field is shown".
- **The briefing leads scheduled work and crons to the `sync` module** (NSO-400): with `sync` active, the "Platform modules and skills" section of the `create_app` / `get_app` briefing says that work on a schedule (a cron, a periodic refresh of data from an external API: scores, prices, fixtures, a feed) is the `sync` module (`skill_info('sync')`), and that the server never runs app code: there are no cron scripts of your own, a sync source fetches JSON from a proxy upstream into a data collection and any computation happens in the browser. Without `sync` the briefing promises no cron. The sync skill's "When to use" and its `skill_info()` line name crons, scheduled tasks and periodic updates.
- **`@freema/drobek-modules` publishes the module contract and the test kit only** (NSO-397): the npm package's `@drobek/modules` entry is the contract (`defineModule`, the slot helpers, `z`, `respond`, `ModuleError`, the rule and error helpers, the types) and `@drobek/modules/testing` the test kit; the server's runtime, registry, loader, limits provider, end-user sessions and secret/config helpers (`ModuleRuntime`, `loadModuleRuntime`, `RuntimeDeps`, `createLimitsProvider`, `CORE_LIMITS`, `signLimitsRequest`, `setModuleSecret`, `ModuleJobScheduler`, …) are no longer published. `@drobek/modules/testing` adds `loadModules` and `buildSdk` (the server's loader and SDK build) and `memoryMailGuard`; `loadModules` and `buildSdk` from `@drobek/modules` keep working, deprecated, until the next breaking version. A test keeps the contract's import graph off the runtime, the published declarations are snapshotted, and the external-module check also scaffolds a module with the packed `create-drobek-module` and installs, typechecks and tests it outside the repository. docs/MODULES.md "Public API and semver" says what is public and what counts as breaking.
- **Sign-in providers declare their API; an outdated one refuses the start** (NSO-368): an `auth.provider` contribution now declares `apiVersion: 2` (`AUTH_PROVIDER_API_VERSION` from `@drobek/modules`) — the auth provider API whose `callback()` answers the verified `issuer`. A provider without it (written before the issuer was required) or with another value refuses the server start with `module "<name>": its contribution to the slot "auth.provider" (module "auth") does not pass the slot's schema — apiVersion: missing — …` and the fix, instead of loading and failing every sign-in with `provider_error`. To migrate, return the verified `issuer` and add `apiVersion: 2` (docs/MODULES.md "Compatibility"); the built-in `oidc` declares it. `MODULE_CONTRACT_VERSION` stays `1.2.0`: modules declaring `'^1.1'` without an `auth.provider` contribution load unchanged. Issuer validation is unchanged.
- **Opt-in modules honour `requires` per workspace** (NSO-396): an opt-in module is on for a workspace only while every module it requires is on there too, transitively — whatever turned it on (the plan's `MODULE_ENABLED_<NAME>`, env or the super-admin switch). Its routes, slot contributions, observers and hooks, `get_app` and `skill_info` follow that closure. Switching one on while a required module is off answers 409 `module_requires_not_enabled`, whose `details.missing` lists what to enable first, in order. Switching a dependency off still applies; its dependents keep their own switch but go off at once, and the dashboard names them before the click and afterwards. The server refuses to start when a default module requires an opt-in one or when `requires` form a cycle.

### Fixed
- **The proxy module page stays readable with many upstreams** (NSO-399): the upstreams assigned to the app (and those its config names but the workspace no longer has) keep their full cards on top; the workspace's other upstreams are a compact list below — name, methods · path prefixes, whether the secret is set — whose rules form opens per entry behind "Assign to this app…". Above 8 unassigned upstreams a name filter sits over the list. The page tells apart a workspace without upstreams, every upstream already assigned, and a filter without matches; a viewer sees the list without actions.
- **Quiet 404s and 405s on the dashboard host; `robots.txt` and `favicon.ico`** (NSO-405): a URL no dashboard route matches (`/wp-admin/install.php`, `/.well-known/agent.json`, `/sse`, …) and a method a route does not take (`OPTIONS` → 405) no longer log `Error: No route matches URL …` / `Invalid request method …` with a stack trace; each logs one info line (`{"name":"http","message":"not served","method","path","status"}`, the path without its query string). Errors at 500 and above still log as errors with their stack. The dashboard host answers `GET /robots.txt` (the landing page with the gallery, `/login`, `/build-with-your-agent` and the llms.txt files allowed; `/workspaces`, `/admin`, `/oauth`, `/mcp`, `/auth`, `/me`, `/invite`, `/api/`, `/gallery/`, `/duplicate/`, `/report` disallowed) and `GET /favicon.ico` (the mascot icon as SVG). App hosts are unchanged: an app serves its own `robots.txt`.
- **The Upstreams list reads only the workspace's own secret rows** (NSO-403): `listUpstreams` computed `hasSecret` from every row of `upstream_secrets` on the server; it now reads only the rows of the workspace's upstreams.
- **The pending-change e-mail is audited as the server's** (NSO-403): the owner notification about a change waiting for confirmation wrote its `email.send` audit row as an app end user ("END USER app end user" in Activity); it is now an actor-less row ("system", `meta.by: "platform"`), like a scheduled sync run. Mail an app sends from an end user's request is unchanged.
- **The proxy follows an upstream's own redirects** (NSO-404): an upstream that answers `301 Location: https://www.denik.cz/rss/` to `/rss` used to hand the 3xx to the browser, whose CSP blocked the absolute target, so the app got nothing. A 301/302/303/307/308 is now followed on the server — for app calls and for jobs (`ctx.upstreams.fetch`, `sync`) — when its target keeps the upstream base URL's scheme, host and port, stays under its base path and allowed path prefixes and the resulting method is allowed; at most 3 hops, each through the SSRF guard again (DNS pinning, port allow-list), with the 20 s deadline and the response cap covering the whole chain. 301/302/303 turn a non-GET/HEAD request into a GET without a body; 307/308 resend method and body. Any other redirect (another host, scheme or port, a path outside the prefixes, a fourth hop, a loop) and any other 3xx but 304 answers 502 with the new proxy code `upstream_redirect`, `details.location_path` (the target's path, never its host) and how to fix it: allow that path prefix on the upstream, or register the target host as its own upstream. No 3xx but 304 reaches the app anymore.

### Security
- **Dashboard Google sign-in uses PKCE and a nonce** (NSO-395): `/auth/google` sends an S256 `code_challenge` and a `nonce`; the verifier and the nonce stay in Redis under the state (10 minutes) next to the state cookie. The callback takes that record once (a missing, expired or replayed state is refused before the token exchange), sends `code_verifier` to the token endpoint and refuses an ID token whose `nonce` claim differs. The token response must now carry an `id_token` (Google's does with the `openid` scope). Failures still land on `/login?error=google`.
- **The auth module clears its flow cookie after sign-in** (NSO-395): `/__drobek/v1/auth/complete` answers a second `Set-Cookie` that expires `__Host-drobek_eu_flow` (same name, path and attributes, `Max-Age=0`) next to the session cookie. A module response header may now be a list (`respond(status, body, { 'Set-Cookie': [a, b] })` sends each item), and `createModuleTestContext().request()` adds `setCookies` (its `headers` joins a list with `, `).
- **Proxy upstreams are capped per workspace** (NSO-403): `UPSTREAMS_MAX_PER_WORKSPACE` (default 20; a limits provider may set it per workspace) — `register_upstream` and the dashboard's Upstreams page beyond it answer `limit_exceeded` with `limit` / `value`, and a keyed upstream gets no dashboard link when it could not be registered anyway. Upstreams over a lowered limit stay and deleting always works. `UPSTREAM_REGISTRATIONS_PER_HOUR` (default 20) caps registrations per workspace within the last hour (counted from the `proxy.upstream.create` audit rows, so a delete does not give the budget back) → `rate_limited` with `retry_after_seconds`. Both are checked under a per-workspace lock in `@drobek/proxy` `createUpstream`. The Upstreams page shows how many upstreams the workspace may hold; the proxy skill, `skills/drobek` and the tool description tell the agent that one upstream is one host and never to register in bulk.

## v0.6.1 — 2026-09-29

### Fixed
- **Claude Code can sign in again** (#46): `/oauth/authorize` accepts an http loopback `redirect_uri` (`localhost`, `127.0.0.1`, `[::1]`) with any port when its host, path and query equal a registered one character for character (RFC 8252 §7.3). Claude Code's Client ID Metadata Document registers `http://localhost/callback` without a port and signs in on an ephemeral one, which the exact-match check refused with "redirect_uri is not registered for this client". https redirect URIs still need an exact match, port included, and `/oauth/token` still compares the exact string stored with the code.
- **IPv6 loopback redirect URIs register** (#46): `http://[::1]…` passes the DCR and CIMD redirect_uri policy (the check compared the hostname without its brackets).

## v0.6.0 — 2026-09-29

### Added
- **Readiness: client-side XSS warnings** (NSO-387): the readiness report adds `xss_html_sink` (innerHTML/outerHTML/insertAdjacentHTML/document.write/dangerouslySetInnerHTML set from a value), `xss_eval` (eval, new Function, string timers — the app CSP blocks them anyway) and `xss_url_sink` (DOM href/src, setAttribute, location, JSX `src` of an iframe/embed/object/script from a value that is not a literal or a fixed-scheme URL), each with file and line and a textContent / createElement / URL allow-list hint. A token-level lint of the scripts and inline `<script>`s (no app code runs, ~3 ms per 100 KB of TS); literals, templates without `${}` and escaped substitutions pass, vendored and `.min.js` files are skipped. Warnings only — nothing new is refused.
- **The built-in `sync` module: scheduled imports into a data collection** (NSO-392): `configure_module('sync', { sources: { players: { upstream, path, every: "15m", collection, items, key?, mode: "replace" | "upsert" } } })` fetches JSON from an upstream assigned to the app (through the proxy module — its allow-lists, the secret injected server-side, the SSRF guard) on a schedule and writes the array at `items` into a `data` collection, all or nothing (the collection's schema and quotas; a failed run changes nothing). A new source or a change of what it fetches or where it writes waits for the owner's confirmation. Failed runs back off; after `SYNC_PAUSE_AFTER_FAILURES` in a row the source pauses and the app pages show a banner until the owner resumes it, a run succeeds or its config changes. Every run is kept (newest 50 per source, `get_logs` kind `"sync"`); runs by hand and failed scheduled runs are also audited `sync.run` (a scheduled one without a user — "system" in the Activity view, `paused: true` on the run that paused the source), resumes `sync.resume`; a successful scheduled run is not audited. New MCP tool `sync_now({ app_id, source })` (write scope, editor+) and `get_logs` kind `"sync"`; the module page lists the sources with Run now and Pause / Resume. Limits: `SYNC_MIN_INTERVAL_MIN` (5), `SYNC_MAX_SOURCES_PER_APP` (10), `SYNC_MAX_RESPONSE_BYTES` (5 MiB), `SYNC_MAX_RECORDS_PER_RUN` (1000), `SYNC_RUNS_PER_HOUR_PER_APP` (60), `SYNC_PAUSE_AFTER_FAILURES` (5), `SYNC_NOW_PER_MINUTE` (2). On in the compose defaults (`DROBEK_MODULES=…,files,sync`); a server with an explicit `DROBEK_MODULES` adds `sync` to use it. Its tables come with the module's own migration (`__drizzle_migrations_mod_sync`); no core migration. `duplicate_app` does not copy the sources.
- **Module contract 1.2: jobs reach upstreams and records** (NSO-392): an `app` job's context adds `ctx.upstreams.fetch(name, request)` (through the module that declares the new `upstreams` authority — `proxy`), `ctx.records.import(collection, records, { mode, key? })` (through the records authority's new optional `importRecords` — `data`) and `ctx.audit(action, meta)`; the new `sync` authority backs the dashboard's sources panel, `sync_now` and `get_logs` `sync`, and `confirmRequired`'s context may read `limits()`. All additive: a module declaring `'^1.1'` loads unchanged, and `proxy` / `data` keep `'^1.1'`. `createModuleTestContext({ upstreams, records })` fakes them for `runJob`.
- **`write_files` edits files in place** (NSO-382): an entry `{ path, edits: [{ old_string, new_string, replace_all? }] }` changes part of an existing file instead of resending it — exact-string replacements applied in order to the latest version's file, each `old_string` matching exactly once unless `replace_all` (1–50 edits per file). They mix with whole-file and delete entries in one call (still one version, one compile). An edit that does not apply refuses the whole call with the new `edit_mismatch` (`path`, `edit_index`, `reason`, `base_version`) and nothing is written. The result adds `base_version`, the version the changes were applied to; a call with edits is stored only on top of that version and re-applied when the same user's other session stored one in between (`busy` after three attempts). Whole-file calls answer as before; `edits` next to `content` / `delete` is still ignored, now with a `warnings: [{ code: "edits_ignored" }]` entry.
- **Module contract 1.2: scheduled jobs** (NSO-391): a module may declare `jobs: [{ name, scope?, every, description?, run(ctx) }]` — a `server` job runs once per interval for the whole server, an `app` job for each live app that configured the module (its interval fixed or read from the app's config, e.g. `every: (config) => config.every`). Core runs them in-process under a Redis lease (once across replicas), at most `MODULE_JOBS_CONCURRENCY` (4) per process, each cut off at `MODULE_JOBS_TIMEOUT_MS` (5 min, its `ctx.signal` aborts); a failure is logged and retried with backoff (1 min doubling, at most max(interval, 1 h)), and an app job's failure shows in that app's `get_logs` runtime as type `module_job` with `module` and `job` (migration 0030). `MODULE_JOBS_ENABLED=0` turns them off on a process; a server whose modules declare no jobs starts no scheduler. `MODULE_CONTRACT_VERSION` is `1.2.0`: a module declaring `'^1.1'` or `'^1.0'` loads unchanged (only a range that excludes 1.2, like `'~1.1'`, is refused). The 1.2 types also list the optional `ctx.pendingConfig`. `skill_info('<module>').jobs`, `createModuleTestContext().runJob(name)`, the scaffold (a commented example) and the external-consumer check know them. Browser-error entries of `get_logs` keep exactly their shape.
- **Publish readiness report** (NSO-384): `write_files` and `publish` answer an additive `readiness: { ready, blocking, warnings, warnings_omitted? }` (each entry `{ code, file?, line?, message, hint }` from the error catalogue), and the dashboard's app page shows the same report for the newest version under "Before you publish". `blocking` is the compile errors — what already stops a publish; nothing new is refused and `secret_in_source` still refuses the write with the same body. Warnings never stop a write or a publish; the first check is `missing_title` (index.html without a `<title>`). The checks read only the version's source files and the app's module configs (no app code runs) and live in `packages/compile/src/readiness/checks/` — one file per check. New operator limit `READINESS_MAX_WARNINGS` (default 50). All existing fields are unchanged.
- **Readiness: module rules audit** (NSO-386): the publish readiness report reads the app's module configs and warns — never blocks — with `data_public_write_no_schema` (a collection anyone may create or update without a schema), `data_public_write_unbounded` (…with string fields without `maxLength` or a schema that accepts extra properties), `data_public_read_personal` (a public read of e-mail, phone or address fields), `rule_needs_auth_module` (a data, forms or proxy rule that needs a sign-in while the auth module is not active), `proxy_public_upstream` (an upstream anonymous visitors may call) and `module_change_pending` (each change still waiting for the owner's confirmation). Every warning names the collection, form or upstream and the exact `configure_module` fix. Forms have no per-form limit or captcha setting, so a public form is not reported. Existing fields, results and module behaviour are unchanged.
- **Background TypeScript check** (NSO-388): esbuild strips types without checking them, so after a write stores a version that compiled, the server type-checks its `.ts`/`.tsx` files in a worker thread — the TypeScript checker over the in-memory files, the server's `sdk.d.ts` (+ the `drobek/<module>` declarations) and React's types; it analyses the sources and never runs them. `write_files` does not wait: its `readiness` adds `typecheck: "pending"`. The result is stored with the version (migration 0031, `app_versions.typecheck`), and `get_app` (new additive `readiness` of the newest version), `publish` and the dashboard's app page list each error as a `type_error` warning (`file`, `line`, `TS<code>: …`) with `typecheck: "checked"`. A check over a limit gives `typecheck: "unavailable"` and no type warnings (logged); a version without `.ts`/`.tsx` or that did not compile has no `typecheck` field. Type warnings never block a write or a publish. New operator limits `TYPECHECK_WORKERS` (1; 0 = off), `TYPECHECK_TIMEOUT_MS` (20000), `TYPECHECK_MAX_MEMORY_MB` (512), `TYPECHECK_MAX_FILES` (150). The image now ships `typescript` (pruned to the checker and its lib files) and `@types/react`/`@types/react-dom`.
- **`get_logs kind:"requests"` names the failing paths** (NSO-380): each day adds `failing_paths: { "4xx": [{ path, count }], "5xx": [{ path, count }] }` — the day's top 10 per class (missing files and platform 4xx under `4xx`; rate-limited 429s are not recorded). Path only (no query or fragment, ≤ 256 chars), no visitor data; at most 100 distinct paths per class, app and day, the rest counted as `__other__`. The existing fields and counts are unchanged.
- **MCP tools name the arguments they ignore** (NSO-378): an argument a tool does not take (e.g. `publish({ app_id, user_confirmed: true })`) is still accepted and never passed on, and the result — a failed one too — now carries `warnings: [{ code: "unknown_argument", message, ignored, accepted }]`. `read_file`, `query_data` and `get_logs` send it as a text block after the untrusted envelope. `tools/list` is unchanged; a call without unknown arguments answers exactly as before.

### Fixed
- **A data collection that waits for the owner's confirmation says so** (NSO-377): `/__drobek/v1/data/<collection>` answers `409 pending_confirmation` (`details.collection`) instead of `404 not_found` "Declare it first" when the collection is declared only in the app's pending change. What is applied or confirmed is unchanged. Modules get the pending config as the optional `ctx.pendingConfig` (`createModuleTestContext({ pendingConfig })` in tests).

### Changed
- **Agents find the start skill first** (NSO-379): the MCP server sends `instructions` on initialize (start with `list_apps`; before creating or changing an app call `skill_info('start')`, read the briefing), and `list_apps` answers an additive `next` naming `skill_info('start')` when the server has that skill. Existing fields are unchanged.
- **`publish`'s `assets: "draft"` is explained** (NSO-390): the tool description, the briefing, `skills/drobek` and `docs/AGENT.md` say it means the uploads the preview shows went live with the version (production serves them now). The value is unchanged.
- **Installable apps** (NSO-390): the briefing and `skills/drobek` have an "Installable app (home screen)" section — `manifest.webmanifest` via `write_files` (served as `application/manifest+json`), PNG icons through `create_asset_upload`, `apple-touch-icon`, `viewport-fit=cover` with safe-area padding, `display: standalone` / `fullscreen`, install from the published URL.
- **Per-visitor state belongs in `localStorage`** (NSO-376): the data skill, its "use when" line, the briefing (when the data module is listed) and `skills/drobek` say that state of one visitor without sign-in (game saves, settings) stays in the browser, because the data module has no anonymous per-visitor identity; `drobek.data` is for shared data and signed-in users' records, and the two combine.
- **Caddy compresses responses** (NSO-393): the generated Caddyfile adds `encode zstd gzip` to every site (dashboard, `*.<APPS_DOMAIN>`, custom domains) in all TLS modes — `200` responses of at least 1 KB with a text type (HTML, CSS, JavaScript, JSON, XML, SVG, fonts, wasm); a 443 KB app bundle goes over the wire as ~134 KB gzip. `text/event-stream` is not in the list, so MCP's SSE responses still arrive unbuffered; `206` ranges and images pass through unchanged. Self-hosters pick it up with `task selfhost:init` (or `task caddy:config`) and a Caddy reload.
- **Published apps load without the inline source map** (NSO-381): the production host and custom domains serve a compiled `main.js` / `main.css` (and every extra entry) without its inline source map, ending in `//# sourceMappingURL=main.js.map`, and serve that map at `/main.js.map` — browsers fetch it only when devtools opens. A sample app's `main.js` drops from 342 KB to 106 KB. Split at serve time, so already published versions get it too with nothing re-stored; the preview and version hosts serve the bundle exactly as before.

## v0.5.3 — 2026-09-28

### Changed
- **Platform e-mails have real buttons and name the server** (NSO-375): the pending-change mail, the abuse-report, takedown/restore, publish notification, publish approval/block, lost-domain and invite mails link the dashboard page as a button (the address stays in the text part and as a fallback line). A button can only point at the server's own origin (`PUBLIC_APP_URL`, or `PUBLIC_ORIGIN` for invites); an app's mail (`ctx.email.send`) still renders as escaped text with no links and cannot add buttons.
- **Self-hosted wording** (NSO-375): the mails say "the dashboard at <host of PUBLIC_APP_URL>" and end with "Sent by the drobek server at <host> because …" instead of "Sent by an app hosted on drobek"; the pending-change mail goes out under the server's sender, not the app's `fromName` / Reply-To; the sign-in code mail names the sign-in page's host.

### Fixed
- **Invite links fall back to `PUBLIC_APP_URL`** (NSO-375) when `PUBLIC_ORIGIN` is unset, instead of `http://localhost:3041`.

## v0.5.2 — 2026-09-28

### Changed
- **All workspaces shows each workspace's apps** (NSO-373): a super-admin's list on `/workspaces` reads "3 apps · 1 published" per workspace ("No apps" when empty; deleted apps are not counted), from one grouped query.

### Docs
- **Community modules** (NSO-374): `docs/MODULES.md` says that an npm package with the `drobek-module` keyword is listed on www.drobek.app/modules under "Community modules" (not reviewed), and that the submission form gets it reviewed into the directory.

## v0.5.1 — 2026-09-28

### Added
- **`/api/version` names the build and the process start** (NSO-340). Next to the unchanged `sha`, `version` and `modules` it answers `name` (`"drobek"`), `commitTime` (the committer time of `sha` in UTC ISO, baked into the image as the `COMMIT_TIME` build arg by CI, `task build` and `task e2e:image`; the same sources rebuild to the same value; `null` when unknown) and `startedAt` (when the running process started, i.e. the last deploy or restart).

### Changed
- **Activity tells a duplicates switch apart** (NSO-340): turning "Allow duplicates" on or off reads "Allowed duplicates of the app from the public gallery" / "Stopped allowing …" instead of "Listed the app in the public gallery"; `app.gallery_listed` records `previousAllowDuplicate` next to `previousDescription`. Earlier entries keep their old summary.
- **The duplicate page names the source workspace with its slug** (NSO-340): "From the workspace Personal (/smoke)" instead of "By Personal", since every personal workspace is called Personal.

## v0.5.0 — 2026-09-27

### Added
- **Duplicate an app from the gallery** (NSO-340). An owner turns on "Allow duplicates" next to "Show in the gallery" (off by default; agents pass `allow_duplicate` to `set_gallery_listing`, inside the listing's confirmation). A signed-in person then copies the app on the dashboard at `/duplicate/<slug>` (sign-in first, then back) or with the new MCP tool `duplicate_app({ from, workspace?, name? })` (scope `write`, editor+ in the target workspace): a new, unpublished app with the published files as version 1 that remembers its source ("Duplicated from" in the app header, `duplicated_from` in `get_app`). The source's module settings are proposed to the copy through its confirmation flow, without e-mail addresses and proxy upstreams; secrets, data, end users, uploads, app assets, domains and the listing are never copied. Audited `app.duplicate` / `app.duplicated`; `DUPLICATES_PER_USER_HOUR` (default 10) caps copies per person. The public gallery API adds `duplicable`, `duplicateUrl` and `duplicates` to each item. Migration `0028_gallery_duplicate`.
- **Likes and opens in the public gallery** (NSO-340). Each `GET /api/public/gallery` item carries `likes` (signed-in accounts that like the app, one per account), `opens` (visits through the gallery in the last 30 days), `openUrl` and `likeUrl`; `?sort=popular` orders by 5 × likes + opens (page mode). `/gallery/open/<slug>` counts a visit per app and day — no prefetch, no `HEAD`, at most `GALLERY_OPENS_PER_IP_HOUR` (60) per IP — and redirects to the app; nothing about the visitor is stored. `/gallery/like/<slug>` asks the visitor to sign in, then likes or unlikes (`GALLERY_LIKES_PER_USER_HOUR`, 30) and returns to `?back=` when its origin is in `GALLERY_FRAME_ANCESTORS`. `get_app` shows `likes` and `opens` read-only. Migration `0029_gallery_likes`.
- **After a dashboard duplicate, the copy's Overview says what happened to the module settings** (NSO-340): applied, waiting for confirmation (with a link to the module page) or not copied, with the reason and the next step.

### Changed
- **Duplicates: the hourly cap holds under parallel requests, and `from` must be this server's** (NSO-340). `DUPLICATES_PER_USER_HOUR` is checked and recorded in the copy's create transaction under a per-person lock, across workspaces and dashboard/MCP; a copy counts once its app exists. `duplicate_app` takes a slug or an address of this server (app host, verified custom domain, `/duplicate/<slug>`); another server's address is `invalid_params` instead of copying a local app with the same slug.
- **The workspace app search ignores accents and case** like the public gallery (one shared helper, `@drobek/apps/search`): "podzimni" finds "Podzimní obloha"; `%` and `_` match literally (NSO-371).
- **Filtered dashboard lists offer "Clear filters"** with the count after the reset (apps, Forms, Activity, data records, end users); the search and filter fields reset with it and follow back/forward, so the next search does not bring a cleared filter back (NSO-371).
- **The Forms tab tells its empty states apart**: no forms yet (with a copyable prompt for the coding agent naming the workspace and app; viewers are told to ask an editor), no submissions yet, no match for the filters, and a loading error (NSO-371).
- **Activity reads as sentences** (NSO-371). Each row of a workspace's Activity has a readable summary ("Published version 3 (replacing version 2)"), links to the app, version, module, upstream, domain or member it is about while they exist (a deleted one is plain text with a note) and the stored record under "Technical details" with credential-like values redacted. A From/To (UTC days) range joins the filters; the CSV export applies the same filters and gains a `summary` column. Stored audit rows are unchanged.
- **Moderation asks before it acts** (NSO-371). In `/admin/abuse` every reported, taken-down and gallery app links to its dashboard overview and, when published, its public address; the workspace link opens its apps. Take down (also from `/admin/publishing`) and Block publishing open a confirm panel naming the app or workspace, the reason and the effect on its addresses and people; only the panel's button acts, a submit without it is refused, and a repeated submit changes nothing more (a same-reason takedown is now a no-op: no second audit row or e-mail).
- **Admin pages tidied** (NSO-371).
  - Publishing: the states are tabs, and a workspace slug search sits under them. Each workspace groups its live apps with the takedown form.
  - Moderation queue: the takedown reason, Take down and Mark resolved are labelled and on one row.
  - Workspaces: a super-admin gets cards linking to Publishing and the Moderation queue, and can filter the list of all workspaces. The create-team form fits on one row.
  - App Files: the tree and the viewer stack on a phone instead of overflowing the page.
  - Empty lists on these pages say what would appear there and what to do next.
- **Module settings read as settings** (NSO-371).
  - The config form labels each field with the schema's title and description (the built-in auth, email, forms and files modules now declare them). The config keys moved to a collapsed "Config keys for agents" table.
  - Each setting is tagged "Default" or "Saved for this app". A field touched by a change awaiting confirmation shows the new value next to the one in force.
  - `*` marks only text, number and select fields that need a value. A list says whether it can be left empty and how many items it takes.
  - A module's source, contract, slots, contributions and error codes are collapsed "Technical details" on the module page and the workspace Modules page.
  - The workspace Modules page has a search (`?q=`) and a jump list, whose field follows the URL ("Show all", back/forward), and collapses limits and technical facts. Limits read in human units (`10 MB`, `1 min`) with the exact value underneath.
- **Workspace orientation** (NSO-371). The workspace header shows the slug next to the name, the owner of a personal workspace you are not a member of, and where your access comes from: your membership role, or "Superadmin access — not a member". A "Switch workspace" menu reaches your account and your own workspaces; the all-workspaces list names each personal workspace's owner and your access. Authorization is unchanged.
- **Connecting an agent from `/me`** (NSO-371). The MCP URL, the Claude Code command and every client snippet have a Copy button that says whether the copy worked (and selects the text when the browser refuses). A picker shows the agent guide's steps for Claude Code, Claude (web and desktop), Cursor and Codex; the page names the workspace the agent uses by default, lists your workspaces and, while that workspace is empty, offers a first prompt to paste. `/me/connections` explains that it lists approved OAuth clients and points to API keys, the other way in.
- **App pages on a phone** (NSO-371). The app, workspace and publishing tabs are one row that scrolls sideways, with the current tab scrolled into view; long app addresses in the header end in "…"; the version history shows one card per version with its actions below 640 px; long names, file paths and notes wrap instead of widening the page (a long code line scrolls inside the file viewer).
- **Gallery and Settings point to each other** (NSO-371). Settings shows the app's gallery state with a link to the Gallery section on Overview, and the Gallery section links to Settings for visibility and embedding. The Embedding copy says what the list does not control: the dashboard's app-list preview and, while the app is shown in the gallery, the gallery website's preview of the production address.

### Fixed
- **Every release tag gets its GitHub Release**: CI's new `release` job (tags, after the image is promoted) creates it from the tag's CHANGELOG section with the image name, Latest or pre-release. The releases v0.2.1–v0.4.0 were missing and have been added by hand.
- **The e2e stacks allow 300 sign-in codes per IP per 15 minutes** (dev and image flow; production defaults unchanged): the gallery duplicate and like specs pushed the suite over the old test limit of 100.

### Docs
- **Using modules in an app** (NSO-371). `docs/MODULES.md` opens with the app author's steps — available modules, per-app configuration in the dashboard or with `configure_module`, confirming risky changes, secrets, the SDK — and names the operator's `DROBEK_MODULES` section "Enabling modules on your server (operators)". The Compatibility section notes that a sign-in provider must return `issuer` since v0.3.0.
- **Module directory and submission form** (NSO-340). The published modules are also listed at [www.drobek.app/modules](https://www.drobek.app/modules); authors submit theirs through the GitHub issue form `module-submission` (package, repository, contract, license and the module rules) instead of a pull request to `docs/MODULES.md`.

## v0.4.0 — 2026-09-27

### Added
- **Proxy upstreams over MCP** (NSO-372). `list_upstreams`, `register_upstream` and `remove_upstream` (workspace admins; scopes `read` / `write` / `write`) do what the workspace → Upstreams page does, audited as the agent. An upstream with `auth_type: "none"` registers at once; `bearer` / `header` answer `registered: false` with `secret_url`, the Upstreams page with every field filled in through query parameters, where the user pastes the key — a secret is never an MCP argument. `remove_upstream` needs `user_confirmed: true` and names the apps that call it.
- **The public gallery API names each app's configured modules** ([#14](https://github.com/freema/drobek/pull/14)): `modules`, the sorted names with a saved configuration — never config values, pending proposals or owners. It says a module is configured, not that it is used.

### Changed
- **`configure_module('proxy')` refuses an unregistered upstream** (NSO-372) with `invalid_params`, `details.reason: upstream_not_registered`; unassigning such a name still works. The pending confirmation says "with its secret" only for an upstream that has one.
- **A form submission says whether its e-mail went out** (NSO-370). `POST /__drobek/v1/forms/:form` answers `{ ok, id, notified }` and `drobek.forms.submit` / `<Form onSuccess>` pass `notified` on. It is `false` when nobody is to be notified, a mail limit or the pause refused the message, or the transport failed; the submission is stored either way.
- **Clearer upstream card and delete-app panel** (NSO-371). On an app's proxy module page the rate-limit input has its own line and Save and Unassign share one row; an upstream that is not registered yet points to the Upstreams page. Delete app names the app and its identifier, lists what deleting does and labels the confirmation field.

### Fixed
- **Gallery search ignores accents** ([#14](https://github.com/freema/drobek/pull/14)): `podzimni` finds `Podzimní obloha`, in both pagination modes, with literal `%`, `_` and `\` still matched as text; built-in PostgreSQL normalization, no migration.

### Docs
- **The README starts with what drobek is and how to try it** ([#15](https://github.com/freema/drobek/pull/15), NSO-340): drobek.app versus running the same core yourself, what the agent plugins and the backend modules do, three public example apps and a first-app walkthrough; the self-host quickstart stays identical to `docs/SELF-HOSTING.md`.

## v0.3.4 — 2026-09-27

### Changed
- **Sign-in and account pages point to the next step** (NSO-366). `/login` says that a new email gets an account and what drobek does, with a link to the docs (`<DOCS_URL>/overview`, or the README when `DOCS_URL` is unset). `/me` adds **Start building**: this server's MCP address, the Claude Code `claude mcp add` line and a link to the agent guide.
- **CI runs the lint, typecheck and unit job, the external module check and the image e2e in parallel** instead of one after another. The e2e job pushes the tested image as `ghcr.io/freema/drobek:<sha>` on `main` and tags; a new job tags that image `edge` (main) or `vX.Y.Z`, `latest` and `previous` (tags) once all three pass — no rebuild. The npm job runs after it.
- The external module check pins `drobek-module-counter` at the commit that installs the published `@freema/drobek-modules` / `@freema/drobek-sdk` 0.3.3.

### Fixed
- **`qs` 6.16** ([#13](https://github.com/freema/drobek/pull/13)) — an override replaces Express 4's `qs` 6.15.3 (advisories GHSA-x5fp-wj9c-mxmx and GHSA-4mjr-xmp4-gh2g); Express stays on 4.

### Removed
- Dead code ([#13](https://github.com/freema/drobek/pull/13)): the test-only `canReadActivity` and `activityCsvLines` helpers (the Activity route and the CSV export already use the live checks and serializers). The auth, module and app-host cookie readers share `readCookieValue` from `@drobek/core`; parsing is unchanged.

## v0.3.3 — 2026-09-27

### Added
- **Custom domains over MCP** (NSO-366) — everything the dashboard's Domains tab does, through the same `@drobek/domains` operations (validation, `DOMAINS_MAX_PER_APP` from the workspace's limits, DNS verification, audit rows as the agent):
  - `list_domains({ app_id })` (read, viewer+): per domain `host`, `status` (`pending` / `verified`), `primary`, the two DNS `records` (CNAME `<host>` → `<slug>.<APPS_DOMAIN>`, TXT `_drobek.<host>` = `drobek-verify=<token>`), `verified_at`, `last_check_at`, `last_error`, `certificate`; plus `cname_target` and `max_per_app`.
  - `add_domain({ app_id, host })` (write, editor+): returns the records to create.
  - `verify_domain({ app_id, host })` (write, editor+): on failure `domain_not_verified` with `cname` / `txt` = `ok` / `missing` / `wrong` and the expected `records` (the message says DNS can take up to 48 hours), or `dns_unavailable` when a lookup failed (nothing changes).
  - `set_primary_domain({ app_id, host | null, user_confirmed })` (publish, editor+) and `remove_domain({ app_id, host, user_confirmed })` (write, editor+): setting or clearing the primary domain and removing a verified domain need `user_confirmed: true` — the user's explicit yes (else `user_confirmation_required`); removing a pending domain does not.
  - A taken-down app refuses adding, verifying and a primary domain; removing stays possible. `get_app` adds `domains` (`host`, `status`, `primary`).
  - New error codes `invalid_hostname`, `hostname_not_allowed`, `domain_already_added`, `domain_taken`, `domain_not_verified`, `dns_unavailable`. The manifest, the briefing (a custom-domain flow), `skills/drobek`, `skills/start` and docs/AGENT.md describe them.
- **`DOCS_URL`** — the base of a website with the drobek docs (e.g. `https://www.drobek.app/docs`, each page at `<DOCS_URL>/<slug>` with a Markdown twin `<DOCS_URL>/<slug>.md`). When set, `/llms.txt` links the agent guide, the modules, self-hosting and security docs as `.md` pages there, `/llms-full.txt` the agent guide's `.md`, and `/build-with-your-agent` and the landing page `<DOCS_URL>/agent`; unset, they link the Markdown files on GitHub. `/llms.txt` now lists those docs, and `/llms-full.txt` and `/build-with-your-agent` link the agent guide. A value that is not an http(s) URL (or has a query or fragment) stops the server at start.

### Changed
- **npm packages are published under the maintainer's npm scope** (NSO-366): `@freema/drobek-modules`, `@freema/drobek-sdk` and `create-drobek-module` (unscoped; `npm create drobek-module@latest` is unchanged) — there is no `@drobek` npm organisation. Module code keeps importing `@drobek/modules` / `@drobek/sdk`, installed through an npm alias (`"@drobek/modules": "npm:@freema/drobek-modules@^X.Y.Z"`, which `create-drobek-module` writes), and keeps the peer `"@drobek/modules": ">=X.Y.Z"` the server's installer checks; `@freema/drobek-modules` depends on `@drobek/sdk` the same way. The workspace package names are unchanged.

## v0.3.2 — 2026-09-27

### Changed
- **Dashboard copy** ([#12](https://github.com/freema/drobek/pull/12)) — the Users tab tells an empty list, an email search with no match and a failed load apart (a failed load shows no false user count); signing everyone out points to the app's enabled sign-in methods, not only a new code; the app header, history and logs say *build* (identifiers unchanged); settings explain password protection, embedding and deletion in plain terms, and the delete asks for the app's identifier by name.

## v0.3.1 — 2026-09-27

### Changed
- **Who may publish is per workspace, in both modes** (NSO-366). A super-admin sets each workspace to `default` (the `PUBLISH_APPROVAL` mode decides), `allowed` (may publish in both modes — what v0.3.0 called approved; approved workspaces stay allowed) or `blocked` (may not publish in either mode); setting one clears the other. For one publish: a super-admin publisher is always allowed, a blocked workspace is refused, an allowed one or one with a super-admin member may publish, otherwise `open` allows and `approval` refuses as before. `PUBLISH_APPROVAL` still defaults to `open`, so a server lets everyone publish and the operator turns a workspace off when needed.
- **`set_publish_approval` is renamed `set_workspace_publishing`** (it shipped only in the v0.3.0 tag): `set_workspace_publishing({ workspace, publishing: "default" | "allowed" | "blocked", user_confirmed })`, still super-admin only, publish scope, `user_confirmed: true` after the super-admin's explicit yes; returns `{ workspace, publishing, mode, can_publish_now, changed }`. `list_apps` (also `all_workspaces`) and `get_app` add the workspace's `publishing` next to `can_publish` / `publish_contact`.
- **`/admin/publishing`** lists every workspace with its state, filters for waiting requests, default, allowed and blocked, and `?workspace=<slug>` for one. `open` mode puts **Block publishing** / **Unblock** first; `approval` mode **Approve** / **Revoke approval** / **Block publishing**. Each workspace's live apps are listed with the moderation queue's takedown form.
- **Abuse reports** are e-mailed to every super-admin and to `OPERATOR_EMAIL` (each address once, case-insensitive).

### Added
- **Blocking a workspace's publishing**: a publish from it answers the new error `publish_blocked` ("Publishing from this workspace was turned off by the operator of this server (<contact>). Previews, versions and everything else keep working; live apps keep serving unless taken down.", MCP field `contact`; dashboard 403) — no approval request is sent. The dashboard shows "Publishing from this workspace was turned off by the operator (<contact>)." and disables the Publish buttons. Blocking does not unpublish anything (the takedown does). Blocking and unblocking e-mail the workspace's editors and admins what happened and whom to contact. Audit: `workspace.publish_block`, `workspace.publish_unblock` (with `from` / `to`). Migration 0027 adds `workspaces.publish_blocked_at` / `publish_blocked_by`.
- **Publish notifications** (`PUBLISH_NOTIFY=off|first|every`, default `off`): `first` e-mails the operator (`OPERATOR_EMAIL`, else every super-admin) about the first publish of each app, `every` about every publish, at most one e-mail per app per hour. The e-mail names the app, its live URL and custom domains, the workspace, the publisher and whether it came from the dashboard or MCP, the version and whether it was the first publish, a republish or a rollback, with links to the app, its dashboard page and `/admin/publishing?workspace=<slug>` (takedown, block). A super-admin's own publishes are not e-mailed; the mail never delays or fails the publish. An invalid value stops the server at start.

## v0.3.0 — 2026-09-27

### Added
- **Publish approval** (`PUBLISH_APPROVAL=open|approval`, `OPERATOR_EMAIL`). Sign-up stays open: anyone can create workspaces and build and preview apps. With `approval` a workspace may publish only after a super-admin approved it (or when a super-admin is its member); `open`, the default, changes nothing. An invalid value, `approval` without `SUPERADMIN_EMAIL` or an `OPERATOR_EMAIL` that is not one address stops the server at start.
  - The gate sits in `publish()` itself, so the MCP `publish`, the dashboard Publish button and the production rollback all answer `publish_not_approved` ("Publishing on this server needs approval from <contact> … An approval request was sent to <contact> …", MCP field `contact`; dashboard 403). Previews, versions, restore, data, secrets and domains are never gated; apps already live keep serving after a revoke.
  - The first blocked publish, or the owner's **Request approval** button, e-mails the operator (`OPERATOR_EMAIL`, else every super-admin): the workspace, the requester's e-mail, the app and a link to `/admin/publishing` — at most once per workspace per 24 hours until someone decides.
  - `/admin/publishing` (super-admins): waiting requests, unapproved and approved workspaces, **Approve** / **Revoke**. The app pages and the workspace's apps list show "Publishing on this server needs approval from <contact>" with the Request approval button, and the Publish buttons say why they are disabled.
  - MCP: `list_apps` (also `all_workspaces`) and `get_app` return `can_publish` (+ `publish_contact`); the new super-admin-only tool `set_publish_approval({ workspace, approved, user_confirmed })` (publish scope, registered only for a super-admin's grant) approves or revokes with the super-admin's explicit yes. New error code `publish_not_approved`.
  - Audit: `workspace.publish_approval_request`, `workspace.publish_approve`, `workspace.publish_revoke`. Migration 0026 adds the approval columns to `workspaces` and approves every workspace that already has a published app.

### Fixed
- **E-mail sender name**: a bare `EMAIL_FROM` address is sent as `drobek <address>`, so inboxes show *drobek* instead of the address's local part (*no-reply*). `Name <address>` still sets any other name.

### Security
- **Sign-in provider identities are scoped to their issuer** (NSO-360) — a provider account was found by (provider, subject) alone, so after the owner pointed a provider at another issuer (or the operator changed its env fallback) a different person with the same subject there signed in as the existing user, with its data. A person is now (provider, issuer, subject) in the new table `mod_auth_identities`: the same subject from another issuer is a new user, and an address held by an account linked to another identity is refused (`account_linked`, a 409 page) instead of being re-linked. `providers.<id>.relinkByEmail` (owner-confirmed, off by default) moves such accounts to the new issuer by their verified address for an issuer migration, audited `auth.identity_relinked`. The provider's connection — its identity fields and the operator's non-secret `AUTH_<ID>_*` variables — is bound into the sign-in state, the handoff and the session: a change refuses sign-ins in flight ("Start again", `sign_in_denied { reason: settings_changed }`) and signs that provider's sessions out.
  - **Provider authors:** `callback()` must return `issuer` (the verified OIDC `iss` / SAML Issuer) — an identity without it is a `provider_error`. A provider's configSchema may not declare `relinkByEmail`. `endUsers.current` gets `contributions`; a session record may carry `connection`.
  - **Upgrade:** auth migration 0002 creates `mod_auth_identities`, moves every linked `mod_auth_users.subject` there with an unknown issuer and drops the column. Such an identity is claimed once by the same provider + subject asserting the user's own address; any other address is refused. Provider sessions from before this release end (sign in again); e-mail sessions stay. Provider sign-ins in flight during the upgrade answer "Start again".
- **A module switched off for a workspace contributes nothing there** (NSO-360) — an opt-in module that was off for a workspace answered `module_not_enabled` on its own routes, but the modules that were on still received its slot contributions: a slot host's route called them, its sign-in provider was listed and could begin, call back and complete a sign-in, its `auth.signedIn` observer was told, and its sessions stayed valid. Contributions now follow the workspace switch: a route's `ctx.contributions`, the `onAppCreate` / `onPublish` services, `endUsers.current` and the end-user callback (which resolves the app's workspace from its signed state before it picks the provider; `EndUserCallbackApp.contributions`) see only the modules on for the app's workspace; a sign-in in flight when the module is switched off cannot finish, and its sessions end on the next request. `onAppDelete` still gets every contribution (cleanup); `compose` still sees all of them (one config schema per server).
- **The sign-in flow cookie cannot be planted by another app** (NSO-360) — the provider flow's cookie was `__Secure-drobek_eu_flow`, which a page on any other app host under `APPS_DOMAIN` can set with `Domain=<APPS_DOMAIN>`; knowing its own flow token, that app could bind a victim's browser to the attacker's sign-in (login CSRF). It is now `__Host-drobek_eu_flow` (Secure, `Path=/`, no `Domain`), which only the app host itself can set; `complete` reads no other name, so a sign-in begun before the upgrade answers "Start again" (its state or handoff record is refused anyway) and the old cookie expires within 10 minutes.

## v0.2.1 — 2026-09-27

### Added
- **AVIF and ICO assets** — `create_asset_upload` and the Assets tab accept `.avif` (`image/avif`: an `ftyp` box with the `avif` / `avis` brand, major or compatible) and `.ico` (`image/x-icon`: an icon directory with at least one image), sniffed from the bytes like every other asset type, so a `favicon.ico` or an AVIF image of a ported page uploads as an asset. HEIC and QuickTime `ftyp` boxes still sniff as nothing; cursors (`.cur`) are refused. The files module's end-user types are unchanged. ([#4](https://github.com/freema/drobek/issues/4))
- **Gallery search, sort and pages** — `GET /api/public/gallery` takes `?q=` (a case-insensitive substring of the app name or the gallery description; trimmed, at most 100 characters, `%` `_` `\` match themselves), `?sort=new|name` (newest publish first, the default, or name A→Z) and `?page=<n>` (1-based): page mode answers `{ items, page, pages, total, previews }`, counting the same filter (`previews`: `GALLERY_FRAME_ANCESTORS` is set); a page past the last has no items, an invalid page is 1. `sort=name` always answers in page mode (a cursor is ignored). Without `page` (or with a `cursor`) the list keeps answering `{ items, next? }` exactly as before.
- **Live gallery previews** (`GALLERY_FRAME_ANCESTORS`, off by default) — space-separated bare http(s) origins of the operator's gallery website, added to `frame-ancestors` only on the production host (and custom domains) of an app the public gallery shows right now, so the gallery can show a sandboxed, non-interactive `<iframe>` of it; never on preview or version hosts, only while `GALLERY_ENABLED`. An invalid origin stops the server at start. Listing, unlisting, hiding and showing an app now bust the app hosts' cache, so the permission follows at once.

### Fixed
- **`list_apps` for a super-admin** — a server super-admin reaches every workspace (the dashboard lists them all), but `list_apps` showed only the workspaces they are a member of, so an agent with a super-admin key could not find another user's apps. It now also returns `all_workspaces` (`slug`, `name`, `kind`) for a super-admin; `list_apps({ workspace })` with one of those slugs lists its apps.
- **The secret scanner catches Stripe and Slack keys** — `write_files` (and a module config) refused `sk-…` keys but let `sk_live_…` / `sk_test_…` / `rk_live_…` Stripe keys, `whsec_…` webhook secrets and Slack `xox?-` tokens through, and the name rule matched only an exact `secret` / `api_key` / `access_token` name. It now also refuses those formats and any name that ends in one of them (`stripeSecret = "…"`, `"clientSecret": "…"`); publishable keys (`pk_live_…`) and short values stay allowed.
- **Agent docs match the behaviour** — the briefing and the `start` / `port-artifact` skills said a leading `/` in a path is refused; it is dropped (`/src/App.tsx` = `src/App.tsx`). The briefing now says the compiled JS/CSS carry an inline source map with the sources. The `not_found` / `invalid_params` hints name what to check per case, `publish` explains its `assets` field, and the data skill allows localStorage for UI preferences.

## v0.2.0 — 2026-09-26

### Added
- **Resend as the mail transport** (`EMAIL_TRANSPORT=resend`). Every drobek e-mail (dashboard sign-in codes, workspace invites, abuse notices, module mail) goes through one transport: `smtp` (the default, unchanged, Mailpit in dev) or `resend`, which posts each message to `https://api.resend.com/emails` with `fetch` (no vendor SDK, no new dependency, 10 s timeout). `resend` needs `RESEND_API_KEY`; without it, or with an unknown `EMAIL_TRANSPORT`, the server refuses to start. `EMAIL_FROM` stays the sender and must be on a domain verified in Resend. A Resend 429, 4xx or 5xx is reported like any failed send (module mail answers 503); the error names the HTTP status and Resend's error name, never the key or the response text. The rate limits (`OTP_*`, `EMAIL_GLOBAL_*`, …) apply above the transport, the same for both.
  - `docker-compose.production.yaml` no longer requires `SMTP_HOST` itself: drobek refuses to start in production when `EMAIL_TRANSPORT=smtp` has no `SMTP_HOST`, so a Resend setup needs no dummy SMTP host.
- **Sign-in providers for app users** — the `auth` module has a slot, `auth.provider`, through which other modules add ways to sign in (company SSO: OIDC, SAML). A provider only proves a verified identity; the app's allowlist, roles, users and sessions stay with `auth`. The app calls `drobek.auth.signIn('<id>')` (or `<LoginGate>` shows "Continue with <label>"); the IdP returns to one redirect URI per server on the dashboard host, `/__drobek/auth/callback/<id>`, and a 60-second handoff code bound to the app host brings the browser back signed in. The state is HMAC-signed under `DROBEK_MASTER_KEY` with PKCE, and a flow cookie stops login CSRF. `return_to` must be a path on the app host.
  - Config `providers`: `emailCode.enabled` (on by default) and `<id>: { enabled, … }`. Enabling a provider, or changing its identity fields, waits for the owner's confirmation; at least one method stays on. Provider secrets are the auth module's per-app secrets (dashboard only), with an optional `AUTH_<ID>_…` env fallback the provider declares.
  - New: `GET /__drobek/v1/auth/providers`, SDK `drobek.auth.providers()` / `signIn()`, the slot `auth.signedIn` (observers told after every sign-in, 5 s, never blocking), error codes `provider_not_enabled`, `provider_error`, `email_not_verified`, `invalid_state`, the limit `AUTH_PROVIDER_CALLBACKS_PER_IP_15MIN` (60), audits `auth.sign_in { provider }` / `auth.sign_in_denied`. A session remembers its method: turning a method off signs its sessions out.
  - The module contract gains `compose` (a slot host builds its config schema, confirm rules and secrets from contributions) and `endUsers.callback`. Auth migration 0001 adds `mod_auth_users.provider` / `subject`.
- **Public gallery** (`GALLERY_ENABLED`, off by default). An editor or above can list a published app from its Overview page. The listing needs a public description of plain text, at most 160 characters. `GET /api/public/gallery` on the dashboard host returns `{ items: [{ name, description, url, publishedAt }], next? }`, newest first. It takes `?limit` (24 by default, at most 48) and `?cursor`, allows CORS from any origin, is cached publicly for 60 s and limits each IP to `GALLERY_API_PER_IP_MINUTE` requests a minute (default 60). It never includes owner data.
  - An app drops out of the list as soon as it is unpublished, taken down, deleted, password-protected or hidden by a super-admin. A super-admin hides or re-shows an entry in `/admin/abuse`. Every change is audited (`app.gallery_listed`, `app.gallery_unlisted`, `app.gallery_hidden`, `app.gallery_unhidden`).
  - The new MCP tool `set_gallery_listing` (publish scope) lists or unlists an app. Listing requires `user_confirmed: true`, which the agent may send only after the user explicitly said yes to the description it showed them. `get_app` returns the gallery state.
  - Migration 0022 adds `apps.published_at` (set by every publish, backfilled from the audit log) and the gallery columns.
- **Media and assets in apps** — an app can serve video, audio, images and fonts at any path of its own URL space (`/<path>`, next to the files written with `write_files`; an app file at the same path wins). The file never passes through the model: the new MCP tool `create_asset_upload` (write scope) returns a single-use upload URL valid for 30 minutes (`PUT /api/assets/upload/<token>` on the dashboard host, e.g. `curl -T film.mp4 <url>`), bound to one app, one path and the exact size; `list_assets` (read) and `delete_asset` (write) complete the set. The app page gains an **Assets** tab with the same checks, a progress bar and delete.
  - The type is sniffed from the bytes (PNG, JPEG, GIF, WebP, SVG, MP4, WebM, M4A, MP3, Ogg, WAV, WOFF, WOFF2); anything else is refused whatever its name, and SVG is served as a sandboxed attachment. Assets answer `Range` (206/416), `ETag`/`Last-Modified` (304), `If-Range` and `HEAD`, so video seeks work; takedown, the password gate and "not published" apply as to any file. Uploads are audited as the user who asked for the URL.
  - Limits: `APP_ASSET_MAX_BYTES` (100 MiB per file), `APP_ASSETS_QUOTA` (1 GiB per app; both in `CORE_LIMITS`, so a limits provider may set them per workspace) and `APP_ASSET_UPLOADS_PER_HOUR` (60 upload URLs per app). The bytes live under `ASSETS_DIR` (the new `assets_data` volume in the compose files, included in `task backup` / `task restore`). New error codes: `asset_too_large`, `asset_type_not_allowed`, `asset_quota_exceeded`, `asset_path_taken`, `asset_size_mismatch`, `asset_not_found`, `upload_token_invalid`.
  - App CSP: `media-src 'self' blob: https:` and a curated `frame-src` for video embeds (YouTube via youtube-nocookie.com / youtube.com, Vimeo, Google Drive) plus the operator's `APP_FRAME_SRC_EXTRA` (bare `https://host[:port]` origins; an invalid entry stops the server at start).
  - Migration 0024 adds the `app_assets` table.
  - **Assets honour publish.** An upload, a replacement or a delete changes the app's draft assets: the preview shows it at once, the production URL and the custom domains only after `publish` — an agent with the write scope alone can never change what a published app serves. `publish` freezes the assets for the version it puts live; publishing an older version (the rollback) brings back the assets it served when it was last live, and `restore_version` of a published version resets the draft assets to those (`assets_restored`). `list_assets` marks each asset `published` and adds `published_only` and `changes_pending_publish`; `publish` returns `assets` (`draft` / `as_last_published`); the Assets tab shows the same. Files are stored under their sha256 and shared by the draft and the published sets; `APP_ASSETS_QUOTA` counts each unique file of the draft and the published set once, and the sets of up to ten earlier publishes are kept for a rollback while they fit. Migration 0025 adds `app_version_assets` and `app_versions.assets_frozen_at` and freezes the current assets of every published app, so nothing a public URL serves changes on upgrade.
  - An upload URL checks at PUT time that the user it was issued for is still an editor of the app (a member removed since gets `403 forbidden`). A `Range` header without `=` is ignored (200 with the whole file) instead of answering 416.
- **Port a Claude artifact** — the new general skill `port-artifact` (`skill_info('port-artifact')`; `skill_info()` now lists 10 skills with every built-in module) is the procedure an agent follows to move a Claude artifact to drobek from the files it has (the server fetches nothing from claude.ai): ask the user, `create_app`, every text file with `write_files` unchanged, every binary with `create_asset_upload` at the same relative path (`curl -T`, or the link for the user; never base64), check the compile, `list_assets` and the preview, `publish` only on request, and the gallery only after the user's explicit yes. It lists what differs from the artifact sandbox: scripts only from the app and esm.sh, `fetch` only to the app (external APIs through the proxy module), the curated `<iframe>` embeds, no `window.claude.*` runtime API (`window.storage` → `localStorage` or the data module), and the size limits. `skills/drobek` gains a "Port a Claude artifact" section, the briefing points at the skill, and `/llms.txt` / `/llms-full.txt` name the plugin's `/drobek:port-artifact` command (`PLUGIN_PORT_COMMAND` in `@drobek/agent-dx`).
  - `tests-eval` session d has a fresh agent port `fixtures/artifact/` (an `index.html` with relative paths, a stylesheet, a chapter script, a 2 s H.264 MP4 and three JPEGs, about 6 KiB in total) and checks the paths, the uploads, Range 206 and playback; `tests-e2e/tests/port-artifact.spec.ts` does the same port through the MCP helpers.
- **Modules installed without a new image** (`DROBEK_MODULES_DIR`, default `/data/modules`, the new `modules_data` volume, part of `task backup` / `task restore`). Each `DROBEK_MODULES` entry is looked up first in `<dir>/<name>/node_modules/<package>`, then among the server's dependencies. A module from the directory must be listed in `modules.lock.json` with the sha512 integrity of its whole install directory (`hashModuleTree()` in the new `@drobek/modules/lock`), otherwise the server refuses to start; `DROBEK_MODULES_UNLOCKED=1` skips that check outside production. Such a module gets the server's own `@drobek/*`, `zod` and `drizzle-orm` (a `node:module` resolve hook), and its migrations may only create and change `mod_<name>[_*]` tables with foreign keys to `apps(id)` / `workspaces(id)`. See `docs/MODULES.md` → Installing an external module.
  - `/healthz` and `/api/version` now include `modules: [{ name, version, source, contract }]` (`source`: `builtin` | `dir`; never a path), and the `platform modules ready` log line lists the modules in the same shape.
- **`task selfhost:module:add|remove|list`** — installing a third-party module without building an image. `add -- <spec>` takes anything `npm install` accepts (a version, a tarball URL or local `.tgz`, a git URL), runs npm in a throwaway `node:22-alpine` container over the `modules_data` volume with `--ignore-scripts`, then the image's own installer (`node node_modules/@drobek/modules/dist/cli/module-lock.js`): the package must declare `@drobek/modules` as a peer dependency this server satisfies, nested copies of `@drobek/*` / `zod` / `drizzle-orm` are deleted, the module is imported for its `name` and checked like at start (its `contract` included), moved to `/data/modules/<name>`, recorded in `modules.lock.json` with the server's `hashModuleTree()` and loaded the way the server will — a failure restores the previous install. It prints the `DROBEK_MODULES` line and the restart command; it never edits `.env.production` or restarts drobek. `remove -- <name>` deletes the directory and the lock entry (the module's tables stay) and warns when `DROBEK_MODULES` still names it; `list` shows name, package, version, contract, integrity, whether `DROBEK_MODULES` names it and a status (`ok`, `changed`, `missing`, `unrecorded`). The dev stack's `task module:add|remove|list` do the same over `./.modules` with the host's npm. `docs/SELF-HOSTING.md` → Third-party modules (upgrade, rollback, a derived image for operators with their own CI); `task selfhost:rehearsal` installs a module and checks it survives backup → restore.
  - `docker-compose.production.yaml` reads `DROBEK_MODULES_DIR` from `.env.production` (default `/data/modules`), for a derived image that bakes its modules into another directory.
- **Workspace → Modules** — a new workspace tab, read-only for every member, lists the platform modules the server runs: version, source (built in or installed by the operator), the contract range it declares, availability, the modules it requires, the slots it offers and who contributes, its own contributions, its limits with the value in force for the workspace, and its error codes. A module's page gains "About this module" and an error-code table. `skill_info('<name>')` returns the same facts (`version`, `source`, `contract`, `requires`, `slots`, `contributes`).
- **Config form for records and lists** — the generated module config form edits records of named entries and arrays of objects (add, remove and rename entries, each entry's fields rendered recursively, up to three levels deep) and arrays of a string enum (checkboxes), still without client JavaScript. Deeper values and unions stay a JSON field.
- **Opt-in modules per workspace.** A module declared `availability: 'opt-in'` is active only for the workspaces it is enabled for: by the limits provider (`MODULE_ENABLED_<NAME>`: `1` on, `0` off, over everything else), by `MODULE_ENABLED_<NAME>=1` in the env (every workspace), or by a super-admin on the Workspace → Modules page (every member sees each opt-in module's state there read-only; audited `module.workspace_enable` / `module.workspace_disable`). Elsewhere its routes answer `404 module_not_enabled`, `configure_module` refuses with `module_not_enabled`, `get_app.modules.<name>.enabled` is `false` and the app's `skills` leave it out. `skill_info()` marks an opt-in module `availability: "opt-in"` and takes an optional `app_id` to add `enabled_for_workspace`. Default modules behave as before. Migration 0023 adds `workspace_modules`.
- **npm packages for module authors** — every release tag publishes `@drobek/modules` (the module contract and the test kit), `@drobek/sdk` and `create-drobek-module` at the image's version (CI job `npm`, npm Trusted Publishing, enabled by the repository variable `NPM_PUBLISH`). The published `@drobek/modules` bundles the private workspace packages and ships rolled-up declarations; `zod` and `drizzle-orm` are peer dependencies. All three are AGPL-3.0-only. `node scripts/npm-packages.mjs pack` builds the same tarballs locally.
  - `npm create drobek-module@latest <name>` scaffolds a module: routes over its own table, the SDK slice, a migration, `SKILL.md`, and vitest tests (PGlite with the core migrations, plus the skill gate). `examples/drobek-module-hello` is the scaffold's output plus the slot demo.
  - `@drobek/modules/testing` adds `checkSkill(module)` (the SKILL.md gate the built-in modules pass: the five sections, 150 lines, known error codes, and every code block compiled and typechecked against the module's SDK), `coreMigrationsDir()` and `createTestApp(db)`. `@drobek/skills-check` is now the repo gate that runs this library.
  - `docs/MODULES.md` → Writing a module: the scaffold, the contract and peers, publishing, installing, and the contract ↔ image compatibility table.

### Changed
- **The drobek mascot** — the pixel crumb from www is the logo in the core too, from one shared pixel map in `@drobek/email`: the favicon (a `data:` SVG), the breadcrumb (it links to your workspaces), the sign-in pages and the landing page (with the www idle loop, still for reduced motion), the error page, and the e-mail header (drawn with table cells, so it shows where a client blocks images).
- **Minimal e-mails** — every drobek e-mail (sign-in code, workspace invite, module mail) uses one plain white layout: the wordmark with the crumb, the text, a one-line footer, and no grey card. The sign-in code is one copyable string instead of a box per digit, and "ignore this e-mail if you did not ask" is said once instead of twice.
- **The dashboard no longer knows the built-in modules by name** — the collections and upstreams editors appear for any module that declares `dashboard.editor: 'collections'` or `'upstreams'`, so a replacement module with the same capability keeps them. The Forms, Users and Uploads tabs name the missing capability instead of a module when no module provides it.

## v0.1.4 — 2026-09-25

### Changed
- **One dashboard layout** — every workspace and app page has a breadcrumb (`Workspaces › <workspace> › <app> › <section>`, every part a link except the last) in place of the "← back" links, and every page has the same width. The workspace pages share a header with the workspace tabs (Apps, Members, Activity, Upstreams). The app header and its tabs are now on every app page, including Modules and the module detail page. Inputs, selects, buttons and link-buttons share one height, border and radius, so the Activity filters (with Clear and Export CSV) and the app-list filters line up on one row. Wide tables scroll inside their box on a phone instead of scrolling the page.
- **App-list thumbnails** — a public, live app with a published or compiled version shows a small, non-interactive preview of its page. It is a sandboxed, lazy, `inert` iframe (`credentialless` where the browser supports it) of the app's own host, which is never the dashboard origin. Password-protected, taken-down, inactive and never-compiled apps show a placeholder. To make this possible an app's `frame-ancestors` now always includes the dashboard origin (`PUBLIC_APP_URL`), next to the owner's embedding setting. See `docs/SECURITY.md`.
- **Footer** — it now reads `drobek <version> · <sha> · Source (AGPL-3.0) · ★ <stars>`. The star count is read server-side from api.github.com (unauthenticated, 3 s timeout) and kept in memory for an hour. A page never waits for it: a failure just omits the stars. `DASHBOARD_GITHUB_STARS=off` turns the lookup off.
- **Upstreams page** — a short introduction explains what an upstream is, how an app gets access, and that the secret is entered only there: neither the app nor the agent ever sees it.

### Fixed
- **App slugs keep accented letters** — `create_app` derived the slug by dropping every non-ASCII letter, so "Podzimní obloha" became `podzimn-obloha`. Accents are now transliterated (`podzimni-obloha`, ß → ss, ł → l, ø → o). Existing slugs do not change.
- `.gitguardian.yaml` marks the dev and e2e stacks' throwaway Postgres login as test-only, so secret scanners stop reporting it.

## v0.1.3 — 2026-09-24

### Added
- `api-key-create --create-user` (`task api-key:create … CREATE_USER=1`) creates the user when the e-mail never signed in, so an operator can give a smoke test or a headless agent its own service identity without a mailbox. Without the flag the CLI still refuses an unknown e-mail. `docs/SELF-HOSTING.md` → Upgrades and rollback shows the live-server check: such a key plus `task e2e:smoke`, the whole MCP loop over public HTTP.

## v0.1.2 — 2026-09-24

The first published image. It carries the v0.1.1 fix (v0.1.1 was tagged, its CI run was cancelled in favour of this release).

### Added
- `LANDING_URL` — an operator with their own website sends the dashboard's `/` there with a 301 instead of the built-in landing page (drobek.app → www.drobek.app), so the noindex dashboard host never competes with the website in search.

## v0.1.1 — 2026-09-24

### Fixed
- **Sign-in and every dashboard form behind a TLS proxy** — React Router 7.18 (the NSO-333 dependency update) refuses an action whose `Origin` differs from the origin of `request.url`; behind Caddy drobek builds `http://…` while browsers send `Origin: https://…`, so every POST answered 400. The host of `PUBLIC_APP_URL` is now an allowed action origin. v0.1.0 was tagged but never published as an image (its CI e2e run caught this).

## v0.1.0 — 2026-09-24

### Release summary

First release of drobek as a cloud workspace for agent-built web apps. An agent connects over MCP, writes files, drobek compiles them in-process with esbuild, keeps every write as a version with a preview host and publishes on request. App backends are TypeScript platform modules; a dashboard covers secrets, confirmations, domains, data and users. One Node process, one image (`ghcr.io/freema/drobek`), Postgres + Redis, Caddy for TLS.

This release replaces the earlier static-bundle upload product entirely (see the ⚠️ Breaking sections in `CHANGELOG.md`: NSO-281, 282, 283, 285).

#### Highlights
- **Agent loop over MCP** (Streamable HTTP): `list_apps`, `create_app`, `get_app`, `read_file`, `write_files` (esbuild diagnostics back), `publish`, `restore_version`, `get_logs`, `query_data`, `configure_module`, `skill_info`. OAuth 2.1 (user-bound tokens, scopes read/write/publish, CIMD + DCR) and `drk_` API keys.
- **Apps on their own origin** — `<slug>.<APPS_DOMAIN>` (production), `<slug>--preview` and `<slug>--v<N>` hosts, `__Host-` cookies, CSP, password gate, on-demand TLS (`ask` endpoint) with Caddy.
- **Platform modules** (`@drobek/modules` contract, `defineModule`, owner confirmations): built-in `auth` (end-user sign-in), `data`, `forms`, `email`, `files`, `proxy`; external modules via `DROBEK_MODULES` (example: `drobek-module-hello`).
- **Dashboard**: app page (publish / restore / unpublish, versions, zip download), Modules tab with confirmations, owner tabs (Data with CSV import/export, Forms, Users, Uploads, Logs), custom domains with DNS verification and re-check, account area (API keys, OAuth connections, Activity), abuse queue for super-admins.
- **Agent DX**: `@drobek/agent-dx` briefing, tool manifest, limits and error catalogue, `llms.txt`; the `drobek` plugin and skills; directory listing kit.
- **Self-hosting**: production compose, `task selfhost:init`, backup/restore, release image tags, `docs/SELF-HOSTING.md` env reference (kept in sync by `pnpm doc-lint`).
- **Plan limits** (`APPS_MAX_PER_WORKSPACE`, `DOMAINS_MAX_PER_APP`) with an optional HMAC-signed limits provider (`LIMITS_PROVIDER_URL`).

#### Security (M1 review + follow-ups)
- SVG sniffer ReDoS and proxy escape fixed; proxy header allow-list, decoding to a fixed point (double-encoded traversal refused), HEAD, IPv6 private ranges, concurrency caps.
- A failed PKCE exchange burns the authorization code; a replayed code revokes its tokens.
- Per-IP rate limits never share an `unknown` bucket; per-principal write limits in `data` and `files`; per-app password-gate cap.
- MCP `read_file`, `query_data`, `get_logs` answer only inside the untrusted envelope (no `structuredContent`); `_owner` hidden from anonymous callers; removed data collections are purged (with confirmation and audit), never orphaned.
- Beacon URLs stored as origin + path only; e-mail guard pause vs OTP quota fixed; `signInAddress` reserved for the auth module.
- DB errors are read and logged through one helper (`@drobek/db`: `pgErrorCode`, `isUniqueViolation`, `dbErrorForLog`) — no bound query parameters in logs; drizzle-orm 0.45.3, nodemailer 10.
- `docs/SECURITY.md` threat table; `/.well-known/drobek-report` and `/report` abuse flow with takedown (451).

#### Operator notes (new / changed env)
- New: `LOGS_PRUNE_INTERVAL_MS` (3600000), `DATA_WRITES_PER_PRINCIPAL_PER_MIN` (60), `FILES_UPLOADS_PER_PRINCIPAL_PER_MIN` (20), `EMAIL_WORKSPACE_HOURLY_SHARE` (50; single-workspace servers may set 100), `APPS_MAX_PER_WORKSPACE` (50), `DOMAINS_MAX_PER_APP` (3), `LIMITS_PROVIDER_URL` (+ secret), `TRUST_PROXY`.
- Changed: `BEACON_RETENTION_DAYS` default 14 → 30 (errors also capped at the newest 500 per app); logs/stats are pruned by a periodic job instead of on read.
- Migrations run on start (`__drizzle_migrations_core` + one journal per module). Back up before upgrading: `task backup`.
- Full list and defaults: `docs/SELF-HOSTING.md` → Environment reference.

#### Verification
`task check` (doc-lint, build, typecheck, lint, knip, ~1 700 unit tests), Playwright e2e against the dev stack and against the production image behind Caddy (`task e2e:image`), an agent eval over three reference apps, and Sonnet black-box passes per milestone block.

The sections below are the detailed change log of this release, newest first.

### drizzle-orm 0.45; DB errors read and logged through one helper (NSO-333)

- `@drobek/db` exports `pgErrorCode(err)` (the SQLSTATE wherever the driver
  or drizzle put it — `err.code`, or the `cause` of a `DrizzleQueryError`),
  `isUniqueViolation(err)` and `dbErrorForLog(err, { stack? })`: a DB error
  anywhere in the `cause` chain becomes `db error <code> (constraint …,
  table …)` — never its message, `detail`, SQL or bound parameters (a
  Postgres message alone can quote the input, `invalid input syntax for type
  integer: "<value>"`); any other error keeps its message, or its stack with
  `stack: true` (for a DB error: the summary plus the stack frames).
- The four local unique-violation checks (`@drobek/apps` slug,
  `@drobek/domains` hostname, `@drobek/tenancy` team slug + personal-workspace
  slug retry) use `isUniqueViolation`. Every log call that recorded a caught
  error's `message` / `stack` / `String(err)` or the error object — serving,
  domains re-check, MCP tool failures, dashboard abuse mail + logs section,
  the module runtime (hooks, requests, e-mail, limits provider, mail guard),
  moderation, app-changed events, the forms / auth / proxy modules, the
  server's background jobs, migrate and the API-key CLI, `@drobek/auth`'s
  `serializeError` — goes through `dbErrorForLog`. The background-job log
  callbacks (`startBlobGc`, `startSlugRelease`, `startLogsPrune`,
  `startFilesSweep`, `startDomainRecheck`) now take the log-safe error text
  instead of the error.
- Guard: `packages/db/src/error-guard.test.ts` (runs in `task check`; the
  package now has unit tests) scans every package, module, example and the
  server and fails with `file:line rule` for a SQLSTATE literal or a
  `.cause.code` read outside `errors.ts`, and for a raw caught error in a log
  call. An exempt line carries `db-error-guard: allow` with its reason.
- Tests: a taken team slug returns `slug-taken` and a personal slug held by an
  unrelated workspace retries with the next suffix, through PGlite and the
  real constraint (`packages/tenancy/src/workspace-slug.server.test.ts`); a
  failed-query log line whose parameters contain an e-mail does not contain
  it (`packages/db/src/errors.test.ts`, `packages/auth/src/logger.server.test.ts`).
  No migration, no new env var.
- **`drizzle-orm` 0.41 → 0.45.3** in all 21 package.json and **`drizzle-kit`
  0.31.10 → 0.31.11** (`@drobek/db`). Since 0.44 every driver error is a
  `DrizzleQueryError` (class name only — its `name` stays `Error`) whose
  `code` is undefined and whose message is `Failed query: <sql>\nparams:
  <values>`; the helpers above read the `cause`, so behaviour is unchanged
  (`errors.test.ts` asserts the real wrapper shape on PGlite). The migrators
  are unchanged: both journals (`__drizzle_migrations_core`,
  `__drizzle_migrations_mod_<name>`) apply on PGlite (every DB-backed unit
  test) and through postgres-js (`runCoreMigrations` / `runJournalMigrations`
  against a Postgres wire server, idempotent on a second run);
  `drizzle-kit generate` over the existing core snapshots reports no schema
  changes and rewrites nothing. Fixes the high advisory GHSA-gpj5-g38j-94v9.
- Dashboard / OAuth routes: React Router's default `handleError` printed a
  loader or action error whole (`console.error(error)` — a failed query's SQL,
  parameters and Postgres `detail`); the server now installs
  `logRouteError` (`apps/server/server/route-errors.ts`), which logs it
  through `dbErrorForLog`.
- `pnpm audit --prod`: no high; 2 moderate (`qs` via `express` 4, out of scope).

### A failed PKCE exchange burns the authorization code (NSO-332)

- `/oauth/token` (`authorization_code`): the first exchange of a code now
  consumes it whether it succeeds or fails — a wrong `code_verifier`,
  `redirect_uri` or client, or an expired code answers `invalid_grant` and a
  later attempt with the right verifier gets `invalid_grant` too (RFC 6749
  §4.1.2, OAuth 2.1). Presenting an already-consumed code revokes the
  refresh-token lineage it was exchanged for and the grant's access tokens,
  with the refresh-reuse mechanism (`revokeLineage`). The link needs no
  column: the lineage's first refresh token takes the id `ac_<code id>`
  (`authCodeRefreshTokenId`; `issueAccessAndRefresh` accepts
  `refreshTokenId`, `consumeAuthCode` returns it). Unit tests in
  `codes.server.test.ts` (each failure shape, replay revocation) and the
  PGlite route test `routes/oauth.token.test.ts`; `mcp-oauth.spec.ts` checks
  the burn and the replay revocation. `docs/SECURITY.md` threat table row.
  No migration.

### Per-IP limits never share an `unknown` bucket (NSO-328)

- A request without a resolved client IP (no trusted `X-Real-IP` — a
  misconfigured proxy, a request that bypassed it, the plain-HTTP dev stack)
  no longer lands in one shared `…:unknown` bucket, which let a handful of
  such clients lock each other out. Its per-IP bucket is skipped; the
  per-code, per-address, per-app and per-user limits still apply.
- One implementation: `perIpLimitKey(ip, bucket)` in `@drobek/core` (the IP,
  or `null` = skip; one `rate_limit_no_client_ip` warning per bucket per
  process). It replaces the copies in the module router (`per: 'ip'`, and
  `per: 'principal'` for anonymous callers — the auth module's
  `AUTH_ATTEMPTS_PER_IP_15MIN`, forms' `FORMS_SUBMITS_PER_IP_HOUR`), DCR
  (`/oauth/register`), the app password gate, the proxy's `public-ip`
  limit, the error beacon and the abuse report form, and `@drobek/auth`'s
  OTP send and verify guards now use it too (their warning event is now
  `rate_limit_no_client_ip`). `@drobek/modules` re-exports it for modules.
- The password gate gains a per-app cap, `UNLOCK_APP_ATTEMPTS` (100 per
  15 min over all clients), next to the 10 per app + IP, so attempts without
  a client IP stay bounded. `createModuleTestContext().request` accepts
  `clientIp: null`.
- e2e: the specs that count a per-IP limit up to its 429 (hello wave, forms
  burst, DCR, abuse report) send their own `X-Real-IP` (`ownClientIpHeaders`)
  — on the dev stack a request without one has no bucket. The bucket resets
  stay for the Caddy flow (`task e2e:image`), where every request is the
  runner's one IP; the redundant reset before the first forms submit is gone.
  `docs/SECURITY.md` and `docs/SELF-HOSTING.md` describe the behaviour. No
  migration.

### Beacon, get_logs and e-mail guard: M1 review low findings (NSO-327)

- **Beacon bucket order**: `recordBeacon` checks the per-app+IP bucket
  BEFORE the per-app aggregate. A request the per-IP bucket refuses never
  reaches the app bucket, so one client can no longer spend the app's
  600/min and silence its error log; rotating IPs is still bounded by the
  aggregate.
- **Beacon URLs without query or fragment**: the SDK beacon reports the page
  as origin + path (`pageUrl`), and `sanitizeEvent` strips the query string,
  fragment and credentials again server-side — `?code=123456` was too short
  for the redaction.
- **`{ signInAddress }` is reserved for the sign-in provider**: only the
  module that owns end-user sessions (`endUsers`, the built-in `auth`) may
  send to it; any other module gets `403 forbidden`
  (`details.reason: sign_in_address_not_allowed`) and nothing is sent or
  counted — in the runtime and in `createModuleTestContext`
  (`assertSignInSender`).
- **The e-mail pause is a fixed window**: tripping a class pause also resets
  that class's hourly counter, so after `EMAIL_GLOBAL_PAUSE_MINUTES` (15, the
  existing env var) the class starts a fresh budget instead of pausing again
  until the old hour ends; `admit` refuses (uncounted) a message that raced
  past `assertOpen` during a pause. Per-app and per-workspace shares stay
  hourly. Sign-in codes still work while notifications are paused (NSO-320).
- **Auth charges OTP counters only after a send**: the auth module's
  `send-code` uses the new `@drobek/auth` `checkOtpRequest` (all layers,
  counters only read, the cooldown still claimed) and `chargeOtpRequest`
  after the code went out. Retries while sign-in mail is paused cost
  nothing, so the user is not rate-limited after the pause. The dashboard
  login keeps `guardOtpRequest`.
- **Periodic get_logs prune instead of prune-on-read**: `startLogsPrune`
  (`@drobek/insights`, started from `apps/server/server/jobs.ts` under the
  Redis lease) removes browser errors older than `BEACON_RETENTION_DAYS` or
  past the newest `BEACON_MAX_EVENTS_PER_APP` per app, and compiles and
  daily request / module-call stats older than 30 days, for every app. New
  env var `LOGS_PRUNE_INTERVAL_MS` (default 3600000) in `.env.example`,
  `.env.production.example` and the SELF-HOSTING env reference.
  `queryRequestLog` no longer deletes. Retention aligned to **30 days / 500
  errors per app**: `BEACON_RETENTION_DAYS` defaults to 30 (was 14), and the
  `get_logs` description, `docs/MODULES.md` and `skills/debug` say so.
- **`get_logs('requests')` flushes in one round trip**: the whole window (up
  to 31 days) is read in one Redis pipeline and written with at most one
  statement per table (was 2 × 31 serial flushes).
- Unit tests: beacon bucket order + IP rotation, SDK `pageUrl`, server URL
  stripping, `assertSignInSender` (runtime, test context), the fixed pause,
  `checkOtpRequest` / `chargeOtpRequest`, the auth retry-during-pause flow,
  the prune and the batched flush (Redis/SQL call counts). No migration.

### Data + files: per-user write limits, no orphan records, text-only untrusted MCP output (NSO-324)

- **Per-principal rate limits** before the per-app ones: one anonymous
  client on `create: public` could use up an app's whole write budget for
  every user. `DATA_WRITES_PER_PRINCIPAL_PER_MIN` (default 60) and
  `FILES_UPLOADS_PER_PRINCIPAL_PER_MIN` (default 20) count per signed-in end
  user, or per client IP for a visitor; a visitor without a resolvable IP
  gets no shared bucket (NSO-309), the per-app limits
  (`DATA_WRITE_RATE_LIMIT`, `FILES_UPLOAD_RATE_LIMIT`) still hold, and a
  refused write counts only against its own bucket. `429 rate_limited` with
  `details.limit` naming the limit that tripped. A small helper in each
  module (`principal-bucket.ts`), not the router. New env vars in
  `.env.example`, `.env.production.example` and the SELF-HOSTING env
  reference; skills and `docs/MODULES.md` updated.
- **Removing a collection no longer orphans its records.** Removing a
  collection that holds records is `confirmRequired` (the pending summary
  names the count); on confirmation `onConfirmed` purges them in the confirm
  transaction, audited `data.collection.purge` (collection + count). An empty
  collection is removed at once. `ConfirmedContext` gains `audit(action,
  meta)` (written in the confirm transaction, actor: the confirming user).
  Stragglers — rows of an undeclared collection — are listed on the Data tab
  as orphan records with a purge form (editor+, the owner types the name;
  `RecordsAuthority.orphans` / `purgeOrphan`, `BoundRecords.orphans` /
  `purgeOrphan` under the config lock, audited `data.collection.purge` with
  `orphan: true`).
- **`_owner` is hidden from visitors**: a caller who is not signed in gets
  records without `_owner` (list, get, create, update) — the opaque id linked
  one user's records for anyone reading a `public` collection. Signed-in
  users, `query_data` and the Data tab keep it; the SDK type is now
  `_owner?: string | null`.
- **`read_file`, `query_data`, `get_logs` answer text only**: no
  `structuredContent`, so a client that feeds `structuredContent` to the
  model can no longer skip the nonce envelope (wrapping the payload's
  strings could not cover it — the keys of a schemaless record are user
  input too). Every other tool keeps both. Tool descriptions (agent-dx),
  `docs/AGENT.md` and `docs/SECURITY.md` say so; the unit harness and the
  e2e `callTool` decode the envelope for assertions.
- The dashboard record delete was already audited (`data.record_delete`,
  NSO-301); it now has a unit test.
- Unit tests in `modules/data`, `modules/files`, `@drobek/modules`
  (runtime), `@drobek/mcp`, `@drobek/agent-dx` and the dashboard Data routes;
  e2e: `data-module.spec.ts`, `files-module.spec.ts`,
  `dashboard-app-data.spec.ts`. No migration.

### Apex landing describes the cloud workspace (NSO-331)

- The anonymous landing at `/` (`apps/server/app/routes/_index.tsx`) no
  longer talks about static micro-apps and dropping a folder. It describes
  the current product in a neutral voice: an agent connected over MCP, the
  write → compile (esbuild diagnostics) → instant preview → publish loop,
  the built-in platform modules (auth, data, forms, email, files, proxy), the
  dashboard (write-only secrets, confirmations, domains, data, users) and the
  AGPL-3.0 self-hostable instance. It links sign-in, `/build-with-your-agent`,
  `docs/AGENT.md` (`AGENT_GUIDE_URL`), `/llms.txt` and the GitHub repository
  (`SOURCE_REPO_URL`, now re-exported from `@drobek/dashboard/footer`); the
  `/healthz` and `/api/version` links stay. Unit test `_index.test.tsx`; the
  `index-console` e2e spec asserts the new copy. No migration.

### Plan limits: apps per workspace, custom domains per app (NSO-329)

- **`APPS_MAX_PER_WORKSPACE`** (default 50): live apps one workspace may
  hold. `create_app` beyond it answers `limit_exceeded` with
  `limit: APPS_MAX_PER_WORKSPACE` and `value`; soft-deleted apps do not
  count. Enforced in `@drobek/apps` `createApp` (the one create path —
  creates in a workspace are serialized on its row), which takes the
  workspace's effective value as `maxApps`.
- **`DOMAINS_MAX_PER_APP`** is now per workspace too, and `0` is valid
  (custom domains off): the Domains tab says why and hides the add form,
  every add answers `limit_exceeded` (`value: 0`). The startup check accepts
  0; `addDomain` takes the workspace's value as `opts.maxPerApp`.
- Both are **core limits** (`CORE_LIMITS`, exported from `@drobek/modules`)
  in the limits catalogue, so `LIMITS_PROVIDER_URL` can set them per
  workspace (plans); a module may not declare either name.
  `ModuleRuntime.workspaceLimits(workspaceId)` returns a workspace's
  effective limits. `docs/MODULES.md` lists them (a unit test keeps that
  table in sync with `CORE_LIMITS`), llms-full.txt's limits and the
  `limit_exceeded` catalogue entry name them. New env var in `.env.example`,
  `.env.production.example` and the SELF-HOSTING env reference. e2e:
  `plan-limits.spec.ts` (@local, fills a workspace to the default 50). No
  migration.

### nodemailer 10, drizzle-orm 0.45 evaluated and deferred (NSO-330)

- **`nodemailer` 6.10 → 10.0.10** (`@drobek/email`, and `apps/server`, which
  keeps it as a direct dependency for the SSR bundle's `import("nodemailer")`).
  7.x was not enough: of the three high advisories, only the recursive
  address-parser DoS (GHSA-rcmh-qjqh-p98v) is fixed in 7.0.11; the quadratic
  address-list parsing (GHSA-2x7j-588g-ccc2, fixed in 9.1.0) and the
  message-level `raw` file access / SSRF (GHSA-p6gq-j5cr-w38f, fixed in
  9.0.1) need 9.x, and the moderates (envelope/EHLO CRLF injection,
  recipient-domain bypasses, `resolveContent` sandbox bypass) go up to 9.1.1.
  10.x additionally makes the remaining address-parser paths linear
  (10.0.5 / 10.0.6 / 10.0.9) and ships its own TypeScript declarations, so
  `@types/nodemailer` (which stops at 8.x) is removed. The breaking changes
  of 7–10 (SES SDK v2, `NoAuth` → `ENOAUTH`, TLS verification for remote
  content fetches, Node ≥ 20) touch nothing drobek uses. The SMTP transport
  is unchanged: `SMTP_SECURE=1` implicit TLS, otherwise STARTTLS on
  `SMTP_PORT` (587), auth only when both `SMTP_USER` and `SMTP_PASS` are set;
  the option mapping is now the tested `smtpTransportOptions()` and the
  message the tested `messageFor()` (address objects for From / Reply-To,
  rendered through nodemailer's stream transport in the unit test).
- The default e-mail footer (`renderEmailLayout`) says "a cloud workspace for
  agent-built web apps" instead of the retired static-micro-app tagline.
- **`drizzle-orm` stays on 0.41** (evaluated, not upgraded). The bump to
  0.45.3 builds, typechecks and passes every unit test, and the migrators
  (`__drizzle_migrations_core`, `__drizzle_migrations_mod_<name>`, PGlite +
  postgres-js), `pgTable` typings and relations need no change — but 0.44
  wraps every driver error in `DrizzleQueryError`, which changes runtime
  behaviour the tests do not cover: (1) `err.code` is undefined on the
  wrapper (the Postgres code moves to `err.cause.code`), so the unique-
  violation checks in `packages/tenancy/src/team-workspace.server.ts` and
  `personal-workspace.server.ts` stop matching — a taken team slug would be
  a 500 instead of `slug-taken` and the personal-workspace slug retry loop
  would abort (`packages/apps` and `packages/domains` already check
  `cause`); (2) the wrapper's message is `Failed query: <sql>\nparams:
  <values>`, so every log line that records `err.message` / `err.stack` of a
  failed query (about 25 sites, e.g. `modules/forms` notification failures
  and `modules/auth` sign-in mail failures, which land in the app log that
  `get_logs` returns to the agent, and `@drobek/auth`'s logger) would start
  carrying bound values such as end-user e-mail addresses and token hashes.
  Upgrading needs a shared DB-error helper (unwrap `cause` for codes, keep
  params out of logs) applied across packages that other work is changing
  now. Remaining high: GHSA-gpj5-g38j-94v9 (identifier escaping in
  `sql.identifier()` / `.as()`) — not reachable, drobek never passes runtime
  input to either; the only `sql.raw` calls (`modules/data` store) take
  fixed literals.
- `pnpm audit --prod` after this change: 1 high (`drizzle-orm`, above),
  2 moderate (`qs` 6.15 through `express` 4). No migration, no new env var.

### files + serving: M1 security review, low findings (NSO-325)

- **No drain after an early answer.** An app-host response sent before the
  request body fully arrived (a `413` in the middle of an upload, a `401`
  before a route read anything, an oversized beacon) now carries
  `Connection: close`; once it is flushed the socket is half-closed, what the
  client still sends is discarded for 2 s (so its kernel does not drop the
  answer on a reset) and the socket is destroyed. Before, keep-alive read the
  whole rest of the upload, for up to the server's 300 s `requestTimeout`.
  New `APPS_MODULE_BODY_TIMEOUT_MS` (120000): a `/__drobek/*` request body
  that does not arrive in time gets `408 request_timeout`.
- **Files sweep** (`startFilesSweep` in `drobek-module-files`, started by the
  server's background jobs when `files` is active, Redis lease): removes the
  uploads of apps deleted `FILES_SWEEP_RETENTION_MS` (24 h) ago, stale
  `tmp/*.part` files and old blobs that no `mod_files` row of any app
  references (per-sha256 advisory lock + a fresh count, like a delete);
  every `FILES_SWEEP_INTERVAL_MS` (1 h).
- **Downloads** open the blob before any header: a file deleted during the
  download still streams in full, one already gone is a clean `404` instead
  of a connection reset.
- **`Content-Security-Policy: sandbox`** on every served file type except
  PDF. The apps host now keeps a module's CSP as a second policy after the
  app CSP (`<app csp>, sandbox`) instead of overwriting it — a module can
  only tighten the app's policy.
- **Public files** are `public, max-age=300, must-revalidate` (was
  `max-age=31536000, immutable`): the URL names the file id, not its
  content, so a delete or a stricter `read` rule reaches shared caches within
  5 minutes. `modules/files/SKILL.md`, `docs/MODULES.md`, `docs/SECURITY.md`
  and the env reference updated. No migration.

### Proxy hardening — M1 review low findings (NSO-326)

- **Response headers are an allow-list** (`@drobek/proxy` `filterResponseHeaders`):
  `Content-Type`, `Content-Language`, `Content-Range`, `Accept-Ranges`,
  caching (`Cache-Control` — then `no-store` —, `ETag`, `Last-Modified`,
  `Expires`, `Pragma`, `Vary`, `Date`, `Age`), `Retry-After`, request ids
  (`X-Request-Id`, `X-Correlation-Id`, `X-Trace-Id`, `Request-Id`,
  `X-Amzn-RequestId`), rate-limit hints (`X-RateLimit-*`, `RateLimit-*`),
  `Content-Disposition` unless the answer is HTML, and `Location` only as a
  relative reference. `Clear-Site-Data`, `Refresh`, `Link`,
  `Strict-Transport-Security`, `Service-Worker-Allowed`, an absolute
  `Location` (it revealed the upstream's base URL) and everything else no
  longer reach the app origin.
- **Encoded bodies are decoded**: an upstream that answers `gzip`, `deflate`
  (zlib or raw) or `br` despite `Accept-Encoding: identity` is decoded, and
  the DECODED size must fit `PROXY_MAX_RESPONSE_BYTES` (a small gzip bomb is
  `upstream_error`); an unknown encoding is `upstream_error` instead of a
  body the app cannot read.
- **Double-encoded path traversal closed** (`normalizeForwardPath`, found by
  the block black-box pass): every path segment is decoded FULLY (up to 3
  rounds; a 4th that still changes it, a malformed escape in the raw
  segment, or a valid escape left beside a literal `%` → `403
  path_not_allowed`) and the `..` / encoded `/` / `\` / control-character
  checks run on that value, so `%252e%252e%252f` (and triple encoding) is
  refused like `../`. Only validated bytes are forwarded: a segment encoded
  at most once goes as written (its one decoding is the checked value), a
  multiply encoded one as `encodeURIComponent` of its decoded value — a
  literal percent sent as `a%2525b` reaches the upstream as `a%25b`.
- **HEAD** on a resource larger than the cap answers again (the declared
  `Content-Length` of a HEAD / 204 / 304 is not a body).
- **Request bodies** go out with `Content-Length`, never chunked.
- **Assignments are bound to the upstream record** (`modules/proxy`): the
  config gains `upstreams.<name>.id`, written by drobek when a workspace
  admin confirms (never by the agent; a written `id` that differs is a
  rebind and needs an admin). A deleted and re-registered upstream no longer
  inherits the old assignments or their `public` rule: calls answer `403
  forbidden` (`details.reason: upstream_replaced`) until the assignment is
  removed, added again and confirmed. Configs from before (name only) keep
  working and are bound lazily by their first call when the app is on the
  current record's allow-list — no migration. `allowAppOnUpstream` returns
  the record id.
- **IPv6 SSRF ranges**: 6to4 `2002::/16` (blocked whole; a blocked embedded
  IPv4 is named in the reason), local-use NAT64 `64:ff9b:1::/48`, site-local
  `fec0::/10` and discard `100::/64`.
- **Concurrency caps**: `PROXY_MAX_CONCURRENT` (32, the whole server) and
  `PROXY_MAX_CONCURRENT_PER_APP` (8) calls in flight; over either → `429
  proxy_busy` + `Retry-After: 1` (new catalogue code). Documented in
  `.env.example`, `.env.production.example`, `docs/SELF-HOSTING.md` and
  `docs/MODULES.md`; `modules/proxy/SKILL.md` names the new errors.
- e2e: `proxy-module.spec.ts` expects the dropped absolute `Location`, a
  relayed relative one and a decoded gzip answer (`proxy-echo` serves
  `/redirect/relative` and `/echo/gzip`).

### Module runtime follow-ups of the M1 security review (NSO-323)

- **Request stats no longer write per response (M3).** The module runtime
  counts a response only for a MATCHED route of an active module — never a
  429 and never an unknown route or method — and the count goes to Redis
  (`drobek:signals:mod:<app_id>:<day>`, one hash field per module and status
  class, 31-day TTL), not to Postgres. `module_request_stats` is written
  lazily: at most once a minute per app and day (a `SET NX EX` marker) and on
  every `get_logs('requests')` / dashboard Logs read, one statement per day
  (`greatest()` so a restarted Redis never lowers a stored count). A cheap
  429 flood therefore costs no SQL at all. The daily numbers of the counted
  classes are unchanged; a 404 of an unknown module route no longer shows up
  in `4xx`. New `@drobek/insights` exports `flushModuleRequests`,
  `memoryModuleStatsRedis`; `recordModuleRequest` takes `{ now, redis,
  flushEverySec }`.
- **Module e-mail budget per workspace (M4).** On top of the per-app shares,
  one workspace (all its apps together) may use at most
  `EMAIL_WORKSPACE_HOURLY_SHARE` percent of each class (notifications and
  sign-in codes; default 50, never less than one app's share) — four apps of
  one workspace can no longer take a whole class. Both shares must pass;
  refusals are `503 unavailable` with `details.limit:
  EMAIL_WORKSPACE_HOURLY_SHARE` (log event `email_workspace_share_exceeded`,
  Redis `drobek:rl:mail:ws:<workspace_id>[:sign_in]`). `MailGuardMeta` has a
  required `workspace_id`. New env var in `.env.example`,
  `.env.production.example` and the SELF-HOSTING reference — raise it to 100
  on a single-workspace server.
- **Streamed CSV export (M5).** `GET /__drobek/v1/data/:collection/export.csv`
  answers a `Readable` of ~64 KiB chunks (the new shared `csvChunks` of
  `@drobek/modules`, which the dashboard's Data export now uses too) instead
  of one string of the whole file; a schemaless collection's columns come
  from one `jsonb_object_keys` statement, so the records are read once. The
  header is pulled before the 200 (a bad filter is still a clean 400); the
  `data.export` audit is written when the stream ends, with `complete:
  false` when the download was cut off. The CSV bytes are unchanged.
- **A stored config that fails its schema degrades per part (M6).** New
  optional module contract field `salvageConfig(merged)` → `{ config, issues
  }`: the runtime serves it (logging the issues once per stored content)
  instead of silently falling back to the defaults. The data module keeps
  every collection that is valid on its own — also a legacy import of more
  than 100 collections, which used to make EVERY collection answer 404 — and
  drops only the invalid ones. No migration.

### Directory listing kit + explicit `idempotentHint` (NSO-307)

- New `docs/listing/`: `README.md` is the submission kit for the Claude
  connectors directory, the Cursor Marketplace and the Codex plugin
  marketplace (shared metadata, tagline, description, example prompts, the
  tool permission summary, per-directory checklists incl. OAuth 2.1, the
  negative-test protocol, the blockers and every `TODO(Tomáš)`);
  `inspector-log.md` is an MCP Inspector (`@modelcontextprotocol/inspector`
  CLI) pass over all 11 tools of a running server with one real call each,
  the negative tests (a write never publishes; a dashboard secret never comes
  back through any of 29 MCP results; credentials refused in files and
  config) and the OAuth metadata checks on the local server.
- Every tool now declares `idempotentHint` explicitly in `TOOL_DOCS`
  (`true` for the reads, `publish` and `configure_module`; `false` for
  `create_app`, `write_files`, `restore_version`); the other hints are
  unchanged. `llms-full.txt` / `drobek://docs/tools` print it. The full hint
  table is guarded in `packages/agent-dx/src/tools.test.ts`, the tools/list
  snapshot and the e2e specs `mcp-core-tools` / `apps-origin`.
- `docs/AGENT.md` and the README link the kit. The plugin
  (`freema/drobek-plugin`, 0.2.0) names `query_data`, `get_logs` and the nine
  skills. No migration.

### Dead code removal, knip gate, dependency audit (NSO-306)

- **`pnpm knip`** (`knip.ts`, knip 6) runs in `task check` (after lint) and
  in the CI quality job; the gate is 0 unused files, exports, types and
  dependencies across the whole workspace. Entry points the plugins cannot
  see (CLIs run by path, the module SDK entries esbuild bundles, scripts
  started from compose / shell) are declared per workspace; every ignore
  carries its reason. New `task knip`.
- Deleted dead code: `inlineSpecifiers` (`@drobek/skills-check`),
  `normalizeEmail` (`modules/auth` config), the `migrationsUpTo` test helper
  (`packages/domains`), the `AppActionIntent` type (`@drobek/dashboard`), the
  `Json` type (`@drobek/modules` merge-patch). About 70 exports that only
  their own file used are module-local now (no behaviour change).
- Removed unused dependencies: `@drobek/insights`, `@drobek/proxy` and
  `@types/nodemailer` from `apps/server`; `@drobek/core` from
  `@drobek/proxy` and `drobek-module-proxy`; the root
  `@electric-sql/pglite`. `apps/server` keeps `nodemailer` (the SSR bundle
  imports it) and the `drobek-module-*` packages (loaded by the registry).
- The DROP list of the plan was already gone after M0-02 and was verified,
  not re-deleted: the old MCP tool bodies (`@drobek/oauth` keeps only the
  transport), the old `serve.server.ts` branches, the MCP part of the dev
  entrypoint, the per-service GHCR images (no mention left), dead
  `.env.example` keys (every key is read by code or compose). `@drobek/sdk`
  is the browser SDK now, not a placeholder, and stays.
- Security updates (`pnpm audit --prod`): `react-router`,
  `@react-router/{node,express,dev}` 7.14.0 → 7.18.4 (Framework Mode DoS /
  turbo-stream advisories); lockfile refresh within the existing ranges for
  `fast-uri` 3.1.8, `ip-address` 10.7.2, `hono` 4.13.8,
  `@hono/node-server` 1.19.17, `body-parser` 1.20.8.
- **Known, not upgraded** (the fixes are major upgrades, left for a
  deliberate change): `nodemailer` 6.10 — high advisories fixed only in 7.x
  / 9.x (address-parser DoS, message-level `raw` file access) plus moderate
  ones; `drizzle-orm` 0.41 — identifier-escaping SQL injection fixed in 0.45
  (a breaking 0.x minor), exploitable only when runtime input reaches
  `sql.identifier()` / `.as()`, which drobek never does; `qs` 6.15 through
  `express` 4 (moderate). No migration.

### Docs rewritten for the cloud workspace + doc-lint (NSO-298)

- New: `docs/SECURITY.md` (threat model as shipped, status of every PHY-76
  finding, known limitations, private vulnerability reporting through GitHub),
  `docs/LICENSING.md` (AGPL-3.0 §13, the arm's-length boundary with
  drobek-web; one licence — the old "dual-license" line is gone),
  `docs/AGENT.md` (connecting Claude / Claude Code / Cursor / Codex, all 11
  tools with scopes, the briefing, skills, llms.txt) and a root `CLAUDE.md`.
- Rewritten: `README.md` (the loop, the self-host quickstart copied verbatim
  from `docs/SELF-HOSTING.md`, agent connection, local development, e2e
  tiers), `docs/ARCHITECTURE.md` (one process, origins, versions, compile,
  serving order incl. 451/404/429 and the negative cache, modules, TLS,
  jobs), `docs/POSITIONING.md` (Macaly Cloud comparison). `SELF-HOSTING.md`
  gains a complete environment reference.
- Archived to `docs/archive/`: TECHNICAL_DESIGN, ROADMAP, USER_FLOWS,
  ANALYSIS, REVIEW*, ROADMAP-critique, prompt-oneshot-implementation,
  fable-prompt-seo-visibility, research/04 (deploy pipeline — deploy_init /
  deploy_commit, BullMQ, `/:ws/app/:slug`) and threat-model-phy-76
  (superseded by SECURITY.md).
- `/llms.txt` links `docs/AGENT.md` (`AGENT_GUIDE_URL` in `@drobek/agent-dx`).
- **`pnpm doc-lint`** (`scripts/doc-lint.mjs`, first step of `task check`
  and of the CI quality job): fails on retired vocabulary outside
  `docs/archive/` and `CHANGELOG.md` (a deliberate negative assertion carries
  `doc-lint: allow`), on a README quickstart that differs from
  SELF-HOSTING's, and on any `.env.example` / `.env.production.example` key
  missing from the SELF-HOSTING environment reference. `.env.example`
  documents `DROBEK_MIGRATE_ON_START` and `AUDIT_RETENTION_DAYS`. No
  migration.

### OTP rate limits: no shared "unknown" client-IP bucket (NSO-309)

- **`/login/verify`**: a request without a resolvable client IP no longer
  lands in one instance-wide `otp-verify-ip:unknown` bucket (~30 sign-ins per
  15 min used to lock everyone out with "That code is not valid"); the per-IP
  bucket is skipped for it. The per-code cap (5 guesses, then the code is
  destroyed) is unchanged and applies to every request.
- The per-IP verify limit is configurable: `OTP_VERIFY_IP_LIMIT` (default 30)
  and `OTP_VERIFY_IP_WINDOW_S` (default 900). `@drobek/auth` exports
  `guardOtpVerify` / `otpVerifyLimitsFromEnv`.
- **Code sends** (`guardOtpRequest`, the dashboard login and the platform
  `auth` module): without a client IP the two per-IP windows are skipped
  instead of shared; per-e-mail cooldown / hourly limits and the global brake
  still apply.
- e2e: the `otp-verify-ip` bucket reset is gone; the dev and e2e compose files
  set `OTP_VERIFY_IP_LIMIT=500`. No migration.

### e2e: the `@smoke` tier cleans up its `smoke-*` app (NSO-316)

- `tests-e2e/tests/mcp-loop.spec.ts` `@smoke`: under `TEST_ENV=local` the
  fresh `smoke-<random>` app is deleted at the end (try/finally, so failed
  runs too) through the dashboard delete action as the smoke user (e-mail
  OTP). Against production (API key only; MCP has no destructive tool) the
  spec re-uses ONE stable app per key, `smoke-<12 hex of a SHA-256 of the
  key>`, via `list_apps` → `get_app`, so deploys no longer accumulate smoke
  apps. One-time cleanup of the older `smoke-*` apps is a manual runbook step
  (docs/progress.md → Next → M0-09). No migration.

### Security: M1 review fixes (NSO-322)

- **files**: the SVG sniffer's regex backtracked exponentially on repeated
  `<?xml?>` / `<!---->` (a few hundred bytes from any signed-in end user
  blocked the event loop for hours). It is a linear scanner now (PIs,
  comments, one DOCTYPE with an internal subset, at most 64 prolog items,
  then `<svg`); an unterminated item is not an SVG.
- **proxy**: a backslash in the forwarded path (`/\evil.com/x`,
  `..\..\admin`, `%5c`) is refused — the WHATWG URL parser reads `\` as
  `/`, so it reached another host with the upstream secret injected, or
  left the base path. The built target must keep the base origin and base
  path, and the allowed prefixes are checked against the parsed target path.
- **proxy**: assigning an upstream to an app and opening its `call` to
  `public` now need a **workspace admin** (editors may still reject);
  confirming puts the app on the upstream's `allowed_app_ids`, which the
  forward path enforces (`403 upstream_not_allowed`; empty = no app). The
  module contract gains `confirmRequired` items `{ change, confirmRole:
  'admin' }` (pending `confirm_role`, `403 admin_required` for others;
  `confirm_role: "admin"` in configure_module / get_app; the dashboard
  pending panel says so) and an `onConfirmed(before, after, { app, db,
  userId, role })` hook inside the confirm transaction.
- **module e-mail**: one app can no longer pause sign-in codes for every
  app: `EMAIL_SIGNIN_APP_HOURLY_SHARE` (default 25 % of the sign-in budget,
  at least 10) per app, Redis `drobek:rl:mail:app:<app_id>:sign_in`; the
  auth module clamps `AUTH_CODES_PER_APP_HOUR` to it
  (`ctx.email.signInShare`).
- **data**: a PATCH merges onto the record inside the app's write lock
  (re-read `FOR UPDATE`) — concurrent PATCHes no longer lose fields.
  Widening a collection's `read` to every signed-in user (`user`) needs the
  owner's confirmation, except for a new empty collection.
- **Performance**: effective module configs are memoized by the stored
  config's content, and the data module's compiled JSON Schemas by the
  schema's content (before, every module request re-parsed the config and
  recompiled every collection schema — ~2 ms each).

### Apps origin: negative cache + per-IP limit for unknown hosts (NSO-315)

- **Negative cache** in `ServeStore`: a slug with no live app and a hostname
  that is no custom domain are remembered for 30 s in their own count-capped
  LRUs (10 000 each), apart from the positive caches — repeating the same
  unknown host is one DB lookup, and a random-slug flood cannot evict a real
  app's entry. One miss answers every host of the slug (prod, preview, `--vN`).
- `createApp` (`@drobek/apps`) now announces an app-changed **`create`** event;
  any event of a slug drops its cached miss, so a new app is reachable on the
  very next request. A `domain` event also drops every hostname miss.
- **Per-IP limit** on "no app here" 404s: `APPS_UNKNOWN_HOST_LIMIT` (default
  60) per `APPS_UNKNOWN_HOST_WINDOW_MS` (default 60 000), counted in Redis
  (`drobek:rl:apps-unknown-host:<ip>`). Past it the answer is `429 Too Many
  Requests` (plain text, `Retry-After`, the base app security headers), and
  while throttled the IP gets 429 without any lookup for hosts the cache does
  not already know as live apps. A client without a recognised IP is never
  counted (NSO-309); the limiter fails open when Redis is down. Other 404
  pages and headers are unchanged. No migration.

### Dashboard account area: API keys, OAuth connections, Activity filter, source footer (NSO-284)

- **`/me/api-keys`**: create a personal `drk_` key (name + `read` / `write` /
  `publish`), shown once in the create response (`Cache-Control: no-store`),
  list with last use, revoke (immediate — the MCP endpoint reads the key row on
  every request). At most 25 active keys per user.
- **`/me/connections`**: the OAuth clients (DCR or CIMD) holding a live grant
  for you — name, source, scopes, last token issued. Revoke deletes the
  client's access tokens, refresh tokens and pending codes for you; its next
  MCP call is 401 and its refresh token `invalid_grant`.
- **Audit**: `api_key.create`, `api_key.revoke`, `oauth_client.revoke` (written
  to the actor's personal workspace), and the dictionary now also lists the
  actions modules/proxy already wrote (`data.export`, `proxy.blocked`,
  `proxy.upstream.create|delete`). Activity + its CSV gain an actor filter
  (`?actor=user|agent|end_user`); end-user rows get their own badge.
- **Footer** on every dashboard page: `Source (AGPL-3.0) · <sha>` linking to
  `https://github.com/freema/drobek/commit/<GIT_SHA>` (AGPL-3.0 §13); a build
  without a sha links to the `main` tree.
- `@drobek/oauth`: `listApiKeys`, `revokeUserApiKey`, `listConnections`,
  `revokeConnection`. No migration.
### Dashboard: the Modules tab (NSO-291)

- **`/workspaces/<ws>/apps/<app>/modules`** lists the server's platform
  modules for the app (configured, pending, missing required secrets);
  **`…/modules/<module>`** (configure_module's `confirm_url`) shows the pending
  change (before → after diff, the module's confirmRequired strings with a
  plain-language risk note, Confirm / Reject), a config form generated from
  the module's JSON Schema (own renderer; the server validates through the
  module's configSchema and puts each error at its field), the write-only
  secrets (Set / Rotate / Remove, `hasSecret` + when set; audit
  `module.secret_set` / `module.secret_remove` with the name only), the data
  module's collections + rules editor (operation × principal, JSON Schema)
  and the proxy module's per-app upstream assignments. Every save goes
  through the configure path, so relaxations wait for confirmation. Viewers
  see everything without controls (POST → 403). The app page shows "N
  changes await confirmation" (`PendingBanner`).
- **`@drobek/modules`**: an agent's `configure_module` that leaves a change
  pending e-mails the app's owners (the `email` module's `{ appOwners: true }`
  path, a `notification`), at most once per app per hour (Redis
  `drobek:rl:modules:pending-mail:<app_id>`), listing everything that waits.
  `configure({ surface: 'web' })` audits as the user and sends no e-mail;
  `moduleView()`, `pendingSummary()`, `secretsStatus()`.
### Dashboard: the app page (NSO-288)

- **App page tabs** (`@drobek/dashboard`): Overview (header + versions +
  health panels), Files, Data, Settings — listed in ONE data-driven array
  (`app-tabs.ts`). The header shows the production / preview URLs (links,
  never a frame), the newest version's compile state, the agent's
  single-writer lease ("your agent / an agent of X is working, last write
  N s ago") with **Unlock**, and **Unpublish**.
- **Versions**: number, time, author, reasoning, compile status + first
  error; **Publish** (an older version = the rollback), **Restore** (a new
  version with that version's files → the preview; refused with 409 while
  another member's agent holds the lease), **Open** `<slug>--v<N>`, Files.
- **Files**: the version's tree (source + built), a read-only viewer with a
  dependency-free highlighter (text only, never markup), **Download .zip** of
  the version (`<slug>-v<N>/source/…` + `<slug>-v<N>/built/…`, streamed,
  `@drobek/apps` `zipStream` on `node:zlib` — no new dependency).
- **Settings**: visibility public / password (scrypt, the app-host gate's
  hasher), the CSP `frame_ancestors` override (validated by
  `parseFrameAncestors`), **Delete app** (type the slug).
- **Apps list**: search (name / slug), published / not published, sort by
  last change / newest / name; deleted apps never appear.
- Everything is role-gated (editor+ mutations — a viewer gets no control and
  403 on POST; viewer+ reads) and audited: new actions `app.unpublish`,
  `app.delete`, `app.slug_release`, `app.lock.release`,
  `app.visibility.public`, `app.visibility.password`,
  `app.frame_ancestors.change`.
- **Soft delete + slug release** (`@drobek/apps`): `softDeleteApp` hides the
  app everywhere (dashboard, MCP `not_found`, every app host 404 — the serve
  cache is busted at once); the slug stays taken for 30 days, then
  `releaseDeletedAppSlugs` renames it to `<slug>~deleted-<id>` (hourly sweep
  next to the blob GC, Redis lease; `createApp` also releases the one slug it
  asks for). Migration **0016** lets the slug CHECK admit that tombstone on
  deleted rows only and adds a partial index on `apps.deleted_at` (additive).
- The lease key + value parsing moved from `@drobek/mcp` to `@drobek/apps`
  (`leaseKey`, `parseLease`, `readAppLease`, `releaseAppLease`; `@drobek/mcp`
  re-exports them); leases now carry `renewed_at`.
### Custom domains (NSO-292)

- **`@drobek/domains`** (new): `domains` table (migration `0018_custom_domains`
  — per-app unique hostname, at most one VERIFIED row per hostname instance-wide,
  one primary per app). Hostname checks (PSL via `psl`, IDN → punycode; names
  under `APPS_DOMAIN`, the dashboard host or `drobek.app`, IP literals and
  special-use TLDs refused with `hostname_not_allowed`), TXT
  `_drobek.<host> = drobek-verify=<token>` + CNAME to `<slug>.<APPS_DOMAIN>`
  (A/AAAA fallback for apex / ALIAS) against an injectable resolver, 5 s per
  lookup; transient failures never drop a verification. `DOMAINS_MAX_PER_APP`
  (default 3, then `limit_exceeded`), `DOMAINS_DNS_SERVERS`,
  `DOMAINS_RECHECK_INTERVAL_MS`, dev-only `DOMAINS_DNS_MOCK=redis`.
- **Daily re-check**: verified domains older than 24 h are re-checked by a
  leased background sweep; a definitive failure unverifies the domain and
  e-mails the workspace's editors and admins.
- **Dashboard**: the app's **Domains** tab (`/workspaces/:slug/apps/:appSlug/domains`)
  — add, DNS instructions, verify, make primary, remove.
- **`@drobek/apps`**: `classifyHost` returns `custom` for a plausible host
  outside `APPS_DOMAIN` (it used to be the dashboard's); `AppHostTarget`
  `{ kind: 'custom' }`; the `domain` app-changed event.
- **`@drobek/serving`**: a verified custom host serves the published version
  (unknown → dashboard, registered-but-unverified → 404, lookup error → 503);
  a primary domain makes `<slug>.<APPS_DOMAIN>` answer 302 to it; the TLS ask
  answers 200 for verified custom domains of live apps.
- **Caddy** (`@drobek/core` generator): an on-demand catch-all `https://` site
  behind the ask — on by default in on-demand mode, `TLS_CUSTOM_DOMAINS=1|0`
  otherwise (needs `TLS_ASK_TOKEN`).
- **Audit**: `domain.add`, `domain.verify`, `domain.unverify`,
  `domain.primary`, `domain.remove`. **MCP** `publish` returns
  `domains: [<default host>, …verified custom domains]`.
### Dashboard: the owner's app tabs (NSO-301)

- **Data tab**: edit a record as JSON (validated by the module), import a
  CSV (≤ 5 000 rows, all or nothing, the first bad row named by its line;
  skips `DATA_WRITE_RATE_LIMIT`, keeps the quotas), delete a collection
  after typing its name. New tabs **Forms** (`/workspaces/:slug/apps/:appSlug/forms`:
  filter, CSV, delete), **Users** (`…/end-users`: role, block, sign everyone
  out), **Uploads** (`…/uploads`: list, nosniff raster preview, delete) and
  **Logs** (`…/logs`: the `get_logs` data, since + Refresh). All mutations
  editor+, audited (`data.import`, `data.record_update`, `data.record_delete`,
  `data.collection_delete`, `forms.submission_delete`, `end_users.role`,
  `end_users.disable`, `end_users.enable`, `files.delete`).
- **`@drobek/modules`** (contract stays 1.0.0 — additive, all optional):
  `records.update/importCsv/dropCollection`, `endUsers.list/setRole/
  setDisabled`, new `submissions` and `files` authorities, `OwnerView`
  (with `limits()`), `RECORDS_IMPORT_MAX_ROWS`. Built-in `data`, `auth`,
  `forms`, `files` implement them. `@drobek/core`: `parseCsv`, `csvUnguard`,
  `CsvParseError`.

### Abuse and moderation (NSO-293)

- **Report pointer + form**: `GET /.well-known/drobek-report` on every app host
  → `{ report_url, app, terms_url }` (public, 1 h); the public form
  `/report?host=` on the dashboard origin (no login, honeypot,
  `ABUSE_REPORTS_PER_IP_HOUR` = 5) stores `abuse_reports`, audits
  `abuse.report` and e-mails the super-admins (once per app per hour).
  `X-Drobek-App: <slug>` on every app-host response.
- **Takedown / restore** (`/admin/abuse`, super-admins only): unpublish + lock
  (`apps.locked_reason`) → 451 on every host of the app (link to `TERMS_URL`),
  `app_locked_by_admin` from `write_files` / `restore_version` / `publish` /
  `configure_module` (and `@drobek/apps` createVersion / publish / restore),
  423 from the module confirm API, `locked_by_admin` in `list_apps` /
  `get_app`, owners e-mailed; audit `admin.takedown` / `admin.restore`.
  Restore does not republish.
- **Publish heuristic** (`@drobek/apps` `screenPublishedVersion`, run by every
  `publish`): password field + a brand word (`ABUSE_BRAND_WORDS`) in the title
  / h1 / text / JS strings → a `heuristic` report + a warn log line. Never
  blocks.
- Migration **0021_abuse_reports** (additive): `abuse_reports`,
  `abuse_report_status`, `apps.locked_reason`.
- **With the app page and custom domains** (NSO-288 / NSO-292): the 451
  also answers on a verified custom domain, and a taken-down app's production
  host answers 451 instead of its primary-domain 302; a report naming a
  verified custom domain attaches to its app. The app page shows the "taken
  down by the operator" banner on every tab and answers publish / restore /
  unpublish with 423; the module page refuses changes with 423 (reject and
  removing a secret stay allowed).

### Self-host packaging: production compose, `selfhost:init`, backup/restore, release tags (NSO-304)

- **`docker-compose.production.yaml`** rewritten: drobek + postgres 17 +
  redis 7 + caddy, `${VAR:?}` fail-fast for every secret, host and
  `SMTP_HOST`, a healthcheck on all four, `restart: unless-stopped`, image
  `ghcr.io/freema/drobek:${DROBEK_IMAGE_TAG:-latest}`, `DROBEK_MODULES`
  defaulting to all six built-ins, configurable `HTTP_PORT` / `HTTPS_PORT` /
  `PUBLISH_IP`, Caddy = the stock `caddy:2-alpine` unless DNS-01. ⚠️ It now
  reads **`.env.production`** (`--env-file .env.production` + `env_file`),
  the project is **`drobek-prod`** and the volumes are `pg_data`,
  `redis_data`, `files_data`, `caddy_data`, `caddy_config` (were
  `postgres_data`, … under project `drobek`, which collided with the dev
  stack's project name) — an instance started from the M0-07 file must move
  its data with `task backup` / `task restore`.
- **`.env.production.example`**: every variable commented (what, how to
  generate, secret or not), the four TLS paths.
- **`task selfhost:init`** (`scripts/selfhost-init.sh`): non-interactive and
  idempotent — `.env.production` (mode 600), `openssl rand -hex 32` for every
  empty secret (never overwrites one), `DOMAIN` / `APPS_DOMAIN` / `TLS_MODE` /
  `HTTPS_PORT` / SMTP from the environment, the Caddyfile rendered with the
  image's own generator (no Node on the host), a `docker compose config` check
  and the next steps.
- **`task backup`** / **`task restore BACKUP=…`** (`scripts/selfhost-backup.sh`,
  `scripts/selfhost-restore.sh`): `backups/drobek-<UTC>.tar.gz` with
  `pg_dump -Fc`, the `files_data` and `caddy_data` volumes, `SHA256SUMS` and
  a `manifest.json` (image tag / id / version / sha, checkout sha, master-key
  fingerprint, counts, sizes, sha256s). Restore verifies, refuses a
  non-empty database (`FORCE=1`) and a different `DROBEK_MASTER_KEY`
  (`ALLOW_KEY_MISMATCH=1`), stops drobek + caddy, restores, starts.
- **`task selfhost:migrate`** = `node dist/server/migrate.js` in the image
  (new: the server's config checks + core and module migrations, then exit);
  **`task selfhost:upgrade`** = backup → pull → stop drobek → migrate ×2 → up.
- **Image versioning** (`ci.yml`): `v*` tags run the full pipeline and push the
  tested image as `vX.Y.Z`; a `release` job retags in the registry (former
  `latest` → `previous`, `vX.Y.Z` → `latest`; pre-releases get only their
  tag). ⚠️ `main` now pushes `:<sha>` + **`:edge`** — no longer `:latest`,
  which means "newest release". Builds are `linux/amd64` only.
- **`/api/version`** returns `{ sha, version }` — `version` from the new
  `VERSION` build arg (`DROBEK_VERSION`, the release tag; `dev` otherwise);
  OCI labels `org.opencontainers.image.{source,revision,version}`.
- **`task selfhost:rehearsal`** (`scripts/selfhost-rehearsal.sh` +
  `tests-e2e/selfhost-rehearsal.mjs`, not in `check` / CI): the quickstart and
  a backup → restore onto a second fresh stack, end to end, timed.

### The built-in `proxy` module (NSO-297)

- **`modules/proxy`** (`drobek-module-proxy`): `/__drobek/v1/proxy/:upstream/*`
  (GET/HEAD/POST/PUT/PATCH/DELETE, raw body 1 MiB) forwards to a workspace
  upstream with its secret injected server-side. Config `{ upstreams: { <name>:
  { rules: { call }, rateLimit? } } }` assigns an upstream to the app —
  assigning one and `call: 'public'` wait for the owner's confirmation.
  `X-Drobek-SDK: 1` on every call, `PROXY_CALLS_PER_MIN` (60 per app),
  `PROXY_PUBLIC_CALLS_PER_MIN_PER_IP` (10) for public upstreams, an optional
  per-assignment `rateLimit`. `get_app` / `configure_module` show
  `info.upstreams[]` with `hasSecret` (never the value). SDK
  `drobek.proxy.fetch(upstream, path, init)`.
- **`@drobek/proxy`**: port allow-list 80/443 (`PROXY_ALLOWED_PORTS`, PHY-76 #8)
  at registration (`invalid_request`) and at connect time (`ssrf_blocked`);
  20 s forward deadline, 5 MiB response cap; the client's `Origin`, `Referer`,
  `Forwarded`, `Via`, `Sec-*` are no longer forwarded, `Accept-Encoding` is
  forced to `identity`; upstream `Access-Control-*` headers are dropped and
  responses are `Cache-Control: no-store`. **Removed:** the dashboard-host
  route `/<ws>/api/proxy/<name>/*`, `PROXY_RATE_LIMIT` /
  `PROXY_RATE_WINDOW_MS`, `canCallProxy`.
- **`@drobek/modules`**: trailing `*` route segments (`req.params['*']`),
  `bodyTypes: ['raw']`, `req.headers()`, `req.rawQuery`, and the optional
  `appInfo(view)` hook surfaced as `modules.<name>.info`.
### The built-in `files` module (NSO-296)

- **`modules/files`** (`drobek-module-files`): end-user uploads. `POST
  /__drobek/v1/files` / `drobek.files.upload(file)` streams one file to
  `FILES_DIR` (per-file cap `FILES_MAX_BYTES` 10 MiB → `413`, aborted while
  streaming; per-app quota `FILES_QUOTA_PER_APP` 500 MiB → `409
  quota_exceeded`; `FILES_UPLOAD_RATE_LIMIT` 60/min). The type is sniffed
  from the bytes — PNG, JPEG, GIF, WebP, PDF, SVG, CSV; anything else (an
  HTML page named `.png`) → `415 unsupported_type`. `GET /:id` serves the
  sniffed type with `nosniff`, `inline` only for images and PDF (SVG and CSV
  as attachments), an ETag and an immutable cache when `read` is public.
  `DELETE /:id` (owner or admin). Blobs are content-addressed and shared
  across apps; one is unlinked when no file references it. Config `{ rules:
  { upload, read }, maxBytes?, allowedTypes }`; opening either rule to
  public waits for the owner. Table `mod_files`.
- **`@drobek/modules`**: route `bodyTypes: ['file']` with `req.file()` (a
  streaming single-file multipart parser); handlers may answer with a Node
  `Readable` body. **`@drobek/serving`** streams request and response
  bodies; **`@drobek/sdk`** sends a `FormData` body as-is.

### The built-in `forms` and `email` modules (NSO-295)

- **`@drobek/email`** (new core package): the SMTP transport and the e-mail
  layout moved out of `@drobek/auth` (which re-exports the old names), plus
  `sendEmail` (sender name sanitized, the address always `EMAIL_FROM`) and
  `renderTextEmailHtml` (plain text escaped into the layout). The dashboard
  login, invites and module mail share it.
- **`modules/email`** (`drobek-module-email`): `POST
  /__drobek/v1/email/notify-admins` / `drobek.email.notifyAdmins(subject,
  text)` (signed-in users) e-mails the app's owners — the editors and
  workspace-admins of its workspace; `EMAIL_NOTIFY_ADMINS_PER_DAY` (20 per
  app) → `limit_exceeded`. Config `{ fromName, replyTo }` (a new `replyTo`
  waits for the owner). It is the app's **mail authority**: every
  notification any module sends counts against `EMAIL_PER_APP_PER_DAY` (50)
  and carries the app's sender name and reply-to.
- **`modules/forms`** (`drobek-module-forms`, requires `email`): `GET
  /__drobek/v1/forms/:form/token`, `POST /__drobek/v1/forms/:form` (JSON or
  text-only multipart, 32 KiB; honeypot `_hp` dropped silently with a log
  counter; HMAC time token `_t` keyed from `DROBEK_MASTER_KEY`, ≥ 2 s old →
  otherwise `429 submitted_too_fast` / `400 invalid_form_token`;
  `FORMS_SUBMITS_PER_IP_HOUR` 10, `FORMS_PER_APP_PER_DAY` 200), admin-only
  `GET :form/submissions` (keyset pagination) and `submissions.csv` (formula
  cells neutralized, audit `forms.export`). Table `mod_forms_submissions`
  (IP stored as a keyed hash). Notifications to the owners and
  `notify.emails` (any change waits for the owner). SDK `drobek.forms` and
  the inline React `<Form>` (`import { Form } from 'drobek/forms'`).
- **Module e-mail in core**: the recipient kind `{ appOwners: true }` and
  recipient lists (validated, de-duplicated, one message per address); the
  operator-wide cap `EMAIL_GLOBAL_HOURLY_MAX` (500 recipients per hour, all
  module mail) is split into two budgets (NSO-320): sign-in codes
  `EMAIL_SIGNIN_HOURLY_MAX` (default 20 % of the cap, ≥ 50, ≤ half) and
  notifications (the rest; one app ≤ `EMAIL_APP_HOURLY_SHARE` %, default
  25). Past its budget a class pauses for `EMAIL_GLOBAL_PAUSE_MINUTES` (15)
  with an `email_global_pause` ALERT log line for the super admin (`503
  unavailable`, `details.reason: email_paused`, fail closed) — notifications
  pausing never blocks sign-in codes; audit
  `email.send` (counts, never addresses). Texts are capped at 20 000
  characters.
- **Module contract** (additive): `requires` (missing dependency → the server
  refuses to start with a message naming `DROBEK_MODULES`), `mail.prepare`
  (the mail authority, at most one), route `bodyTypes: ['json',
  'multipart']` (text fields only; files → `415`), `RateLimitResult.count`.
- Error catalogue: `submitted_too_fast`, `invalid_form_token`; module-route
  meanings of `limit_exceeded`, `unavailable`, `unsupported_media_type`.
- The dev and e2e composes run `DROBEK_MODULES=hello,auth,email,forms`.
  e2e `forms-email.spec.ts`.

### The built-in `auth` module: end-user sign-in (NSO-294)

- **`modules/auth`** (`drobek-module-auth`, a workspace package and a
  dependency of the server, loaded like any module with
  `DROBEK_MODULES=auth`): the people who use an app sign in with a 6-digit
  code e-mailed to them. Routes `/__drobek/v1/auth/send-code`, `verify`, `me`,
  `logout`; config `{ allow: { emails, domains, anyone }, adminEmails }`
  (`anyone: true` waits for the owner); table `mod_auth_users` (migration
  `0000_auth_users`, its own journal); the workspace's editors always sign in
  as `admin`; `disabled_at` users cannot sign in and are signed out on `me`;
  every `me` re-checks the allowlist and the role. Limits
  `AUTH_CODES_PER_IP_15MIN`, `AUTH_CODES_PER_IP_DAY`,
  `AUTH_CODES_PER_EMAIL_HOUR`, `AUTH_CODES_PER_APP_HOUR`,
  `AUTH_ATTEMPTS_PER_IP_15MIN`, `END_USERS_MAX_PER_APP`. Audit
  `auth.sign_in`. Errors `email_not_allowed` (403, no e-mail sent),
  `invalid_code` (400), `too_many_attempts` (429) are in the error catalogue.
  Its skill (`skill_info('auth')`) carries a `<LoginGate>` example.
- **`drobek.auth`** in `/__drobek/sdk.js` (`me`, `sendCode`, `verify`,
  `logout`, `onChange`) and **`import { LoginGate, useAuth } from
  'drobek/auth'`**: React components compiled into the app with the app's own
  React.
- **Inline SDK sources** (`sdk.inline { entry, types }` in the module
  contract): `@drobek/compile` builds `drobek/<module>` into the app bundle,
  resolving its bare imports through the app's `drobek.json`; relative imports
  are refused; an unknown `drobek/<x>` lists the available ones.
- **End-user sessions in core** (`@drobek/modules`): host-only cookie
  `__Host-drobek_eu` (`drobek_eu`, without `Secure`, only in plain-http dev),
  `HttpOnly`, `SameSite=Lax`; Redis `drobek:eu:<app_id>:<token>`, 30 days
  rolling; a per-app epoch (`drobek:eu-epoch:<app_id>`) revokes every session
  of an app at once (PHY-76 #9). The principal resolver fails closed.
- **The principal is authoritative**: the Redis record alone never makes a
  principal. On every module request that carries a session, core asks the
  module that owns end-user sessions (new contract field `endUsers.current`,
  declared by `auth`; at most one per server, none → no session is honoured)
  who the user is now. Disabled, deleted, no longer allowed (allowlist,
  `adminEmails`, workspace editor removed) → anonymous in every module and
  the session deleted; a role change applies on the next request. No cache.
- **`drobek-module-hello`**: `GET /whoami` / `drobek.hello.whoami()` returns
  the visitor as `ctx.principal`.
- **Dashboard API `POST /api/apps/:id/end-user-sessions/revoke`**: the owner
  signs every user of an app out (the confirm API's guards: session, required
  dashboard `Origin`, editor, non-member → 404). Audit
  `end_users.sessions_revoke` (actor user). The two owner APIs share one guard
  implementation (`packages/dashboard/src/app-api.server.ts`).
- **`@drobek/auth`**: the e-mail code and the OTP guard take an optional scope
  (`otpKeyPrefix`), so an app's end-user codes, counters, cooldowns and pauses
  are separate from the dashboard login's; the operator kill switch still
  applies.
- **Module e-mail**: the recipient kind `{ signInAddress }` (one address, for
  a sign-in code); subjects are forced to one line of at most 200 characters.
- The built-in module list moved from the registry (`BUILTIN_MODULES` is
  gone) to `modules/*` packages. The dev and e2e composes run
  `DROBEK_MODULES=hello,auth` with relaxed `AUTH_*` limits.

### Platform modules: the contract, `skill_info`, `configure_module` (NSO-287)

- **`@drobek/modules`** (new): the module contract (`defineModule`, contract
  1.0.0), the registry that loads `DROBEK_MODULES` (short name `x` →
  package `drobek-module-x`, resolved from the server's dependencies; any
  misconfiguration stops the server at start), the per-request app-scoped
  `ModuleContext` (principal from the end-user cookie, `rules.decide`,
  `limits`, `rateLimit`, `secrets.get`, `audit`, `db`, `email`), the
  `ModuleRouter` pipeline (CSRF, rule, rate limit, zod body/query with field
  paths) with one error shape `{ error, message, details?, hint }`, module
  migrations with their own journal (`__drizzle_migrations_mod_<name>`), and
  `@drobek/modules/testing` (`createModuleTestContext`). Contract:
  `docs/MODULES.md`.
- **`/__drobek/sdk.js` + `sdk.d.ts`** on every app host: the SDK core
  (`@drobek/sdk`) plus every active module, bundled with esbuild at start. The
  compiler maps `import { drobek } from 'drobek'` to `sdk.js?v=<hash>`
  (immutable under the current hash, revalidate + ETag otherwise).
  `/__drobek/v1/<module>/…` routes answer after the app's visibility gate; a
  locked app answers `401 password_required`.
- **Migration `0011_modules`**: `module_configs` (sparse merge-patch config +
  one pending change per app and module), `module_secrets` (envelope-encrypted
  per-app module secrets, written only from the dashboard, never returned by
  any API), audit actor kind `end_user`; both tables cascade on app delete.
- **MCP `configure_module`** (scope `write`, editor, takes the lease): a merge
  patch validated against the module's schema; changes the module marks as
  risky are held as pending and return `confirm_url`; values that look like
  secrets are refused; `secrets_missing` lists unset required secrets by name.
  Audit `module.configure` / `module.pending` (actor agent).
- **Dashboard API `POST /api/apps/:id/modules/:module/confirm|reject`**
  (session, required dashboard `Origin`, editor; non-member → 404; nothing
  pending → 409). Audit `module.confirm` / `module.reject` (actor user).
- **MCP `skill_info`** (scope `read`) replaces the planned `module_info`:
  `skill_info()` lists the skills (name + use_when), which `create_app`,
  `get_app` and the briefing list too; `skill_info('<name>')` returns the skill
  plus, for a module, the SDK types, the config JSON Schema and defaults,
  limits and secret names. It never returns a secret value or any app's
  config. General skills come from `skills/<name>/SKILL.md` (the platform
  skill `skills/drobek` is not listed); the image now ships `skills/`.
  Module route errors hint `skill_info('<module>')`; an `unresolved_import` of
  a backend SDK hints the matching skill (`skill_info()` when none is active).
  `get_app` returns `modules.<name>` (config, pending, `confirm_url`, secret
  names with `hasSecret`). The MCP server now has nine tools; the consent
  screen labels list them.
- **`LIMITS_PROVIDER_URL`** (+ `LIMITS_PROVIDER_SECRET`, ≥ 32 chars, checked
  at start): HMAC-signed `GET /limits/<workspace_id>`, cached 60 s in Redis,
  env defaults when the provider is down.
- **`@drobek/agent-dx`**: `MODULE_INFO_RULE` is now `SKILL_INFO_RULE`
  ("Before using a backend … call `skill_info` and follow the skill;
  `create_app`/`get_app` list the available skills."), stated verbatim in
  `skills/drobek/SKILL.md` (guard test) and the plugin's skills; tool docs and
  the error catalogue cover the new tools and every module error code.
- **`examples/drobek-module-hello`**: the example module as an external
  workspace package (routes, SDK, config with a confirm rule, optional secret,
  a limit, its own table and SKILL.md). The dev and e2e composes run with
  `DROBEK_MODULES=hello`.
### Agent DX v0: the drobek plugin, install lines, skill guard (NSO-302)

- **`freema/drobek-plugin`** (new repo, MIT): marketplace `drobek` with plugin
  `drobek` for Claude Code, Codex and Cursor — `.mcp.json` on
  `https://drobek.app/mcp`, a `build-app-on-drobek` skill per host (the Claude
  variant acts only once the user has chosen drobek), the Cursor rule
  `route-app-builds-to-drobek.mdc` and the `/drobek:build-app` command.
  `claude plugin validate --strict` plus the Codex/Cursor validators run in its
  CI.
- **`@drobek/agent-dx` `plugin.ts`**: the plugin's repo, marketplace, install
  commands and MCP URL, and `MODULE_INFO_RULE` — the present-tense module rule
  every drobek skill states verbatim. `/llms.txt` gains a "Plugin (Claude Code,
  Codex, Cursor)" section; `/llms-full.txt` and `/build-with-your-agent` show
  `claude plugin marketplace add freema/drobek-plugin` +
  `claude plugin install drobek@drobek` and point Codex / Cursor at the plugin
  repo, next to the manual MCP connect + skill install.
- **`skills/drobek`**: SKILL.md states the module rule and the hosted
  `https://drobek.app/llms-full.txt`; its README points at the plugin.
  `skill.test.ts` now also guards the loop rules (preview_url, publish only on
  an explicit request, single writer, no secrets) and the module rule;
  `render.test.ts` asserts every input field, result shape and example of every
  manifest tool is in llms-full.txt (with the `@drobek/oauth` parity test:
  tools/list == TOOL_DOCS == llms-full.txt).

### e2e agent loop + CI against the production image (NSO-289)

- **`tests-e2e/tests/mcp-loop.spec.ts`**: the agent loop through a real MCP
  client — the SDK's OAuth provider does discovery, Dynamic Client
  Registration and PKCE (consent driven by Playwright), then list_apps →
  create_app → write_files (compile error → fix) → preview host → publish →
  production host → restore_version → get_app, under 90 s. A second, `@smoke`
  loop authenticates with `SMOKE_API_KEY` (a `drk_` key, env only) and is safe
  against production: public HTTP + MCP, one `smoke-<random>` app, no
  database / Redis / Mailpit. `agent-loop.spec.ts` is now
  `dashboard-insights.spec.ts`.
- **`task e2e:image`** / `scripts/e2e-image.sh` / `docker-compose.e2e.yaml`:
  the production image behind Caddy (`tls internal`, `https://localhost:8443`)
  with throwaway postgres / redis / mailpit / proxy-echo, migrations on boot,
  then the whole `@smoke` + `@local` suite. Runs next to the dev stack.
- **CI** (`.github/workflows/ci.yml`): push to `next` / `main` only (no PR
  trigger), cancel-in-progress; lint + typecheck + unit, then build the image
  once, run the e2e flow against it, and on `main` push exactly that image.
  pnpm store + Playwright browsers cached; no secrets beyond `GITHUB_TOKEN`.
- `task e2e:smoke` takes `BASE_URL_WEB` / `SMOKE_API_KEY` from the environment
  (the post-deploy smoke of M0-09).

### TLS for the apps origin: Caddy, wildcard cert, `ask` endpoint (NSO-286)

- **Caddy in front** (`docker-compose.production.yaml`: drobek + postgres +
  redis + caddy, only Caddy publishes 80/443, volumes `caddy_data` /
  `caddy_config`, secrets only from `.env` / `.env.caddy`). The Caddyfile is
  generated from the environment by **`task caddy:config`**
  (`@drobek/core` `caddyfileFromEnv`, CLI `packages/core/dist/cli/caddy-config.js`
  → `deployments/Caddyfile`, gitignored) and holds no secrets. The dashboard
  host gets a normal ACME certificate; `*.<APPS_DOMAIN>` uses exactly one of:
  a wildcard certificate file (`TLS_WILDCARD_CERT_FILE` /
  `TLS_WILDCARD_KEY_FILE`, picked up after renewal by **`task tls:reload`** =
  `caddy reload --force`), ACME DNS-01 with a Caddy DNS module
  (`TLS_DNS_PROVIDER`, `TLS_DNS_PROVIDER_ARGS`,
  `TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN` for `_acme-challenge` CNAME delegation;
  `deployments/Dockerfile.caddy` builds the module with xcaddy — there is no
  Hostinger module), or on-demand per host, always behind the `ask` guard.
  `TLS_INTERNAL=1` = Caddy's local CA (dev). Ambiguous combinations are
  refused.
- **`GET /api/internal/tls/ask?domain=<host>&token=…`** (`@drobek/serving`):
  200 only for `<slug>[--preview|--v<N>].<APPS_DOMAIN>` of a live,
  non-deleted app; 401 without / with a wrong `TLS_ASK_TOKEN`
  (constant-time); 404 for anything else, for every request while the token
  is unset, and on the public dashboard host; 503 when the lookup fails.
  Caddy returns 404 for `/api/internal/*` on every public site. A set but weak
  `TLS_ASK_TOKEN` (< 32 URL-safe chars, or a `change-me` placeholder) stops
  the server from starting.
- **`TRUST_PROXY`** (`auto` default | `x-real-ip`): with `x-real-ip`
  `getClientIp` reads ONLY `X-Real-IP` (and only a literal IP) — never
  `X-Forwarded-For`. Caddy overwrites `X-Real-IP` with the TCP peer, so
  per-IP rate limits key on the real client behind Caddy. Unset keeps the
  PHY-76 #4 behaviour for nginx fronts. An unknown value stops the server.
- **`task dev:tls`** (`docker-compose.tls.yaml` override): the dev stack
  behind Caddy with `tls internal` on `https://localhost` and
  `https://<slug>--preview.apps.localhost`; Caddy's root CA is copied to
  `.caddy/root.crt` (never installed into a trust store). `task dev:tls:down`
  returns to the plain-HTTP dev stack, which is unchanged.
- Docs: `docs/SELF-HOSTING.md` (production compose, the three TLS paths with a
  CNAME delegation example, the ask contract and its limits, dev TLS).

### ⚠️ Breaking: apps on their own origin, `publish` tool, `__Host-` cookies (NSO-285)

- **Everyone is signed out once.** The dashboard session cookie is renamed
  `drobek_session` → **`__Host-drobek_session`** (always `Secure`, `Path=/`,
  no `Domain` — host-only, so it can never reach an app host). The old cookie
  is ignored. The Google-login state and login-return cookies get the same
  prefix (`__Host-drobek_google_oauth_state`, `__Host-drobek_login_return`).
  The prefix (and `Secure`) is used whenever `NODE_ENV=production` or the
  dashboard origin is https; only plain-http development drops it (browsers
  refuse `__Host-` on `http://localhost`) — the cookies stay host-only there.
- **App serving (host dispatch in `apps/server`).** `<slug>.<APPS_DOMAIN>` →
  the published version (a 404 "not published yet" page before the first
  publish), `<slug>--preview.<APPS_DOMAIN>` → the newest version that
  compiled, `<slug>--v<N>.<APPS_DOMAIN>` → exactly version N. Files come from
  `version_files`: built outputs win over a source on the same path,
  `*.ts`/`*.tsx`/`*.jsx` sources and `drobek.json` are never served, other
  paths fall back to `index.html`. `ETag` = the sha256 (304 on
  `If-None-Match`); `Cache-Control: public, max-age=0, must-revalidate`, and
  `public, max-age=31536000, immutable` for js/css requested with a hash query
  (`?v=<8–64 url-safe chars>`); password apps use `private`. Bytes are cached
  in-process (LRU by sha256, 256 MiB), host resolutions for 60 s; both are
  busted on every new version / publish through the Redis
  `drobek:app-changed` channel (and a full drop on a Redis reconnect).
- **App headers:** the app CSP (`default-src 'self'; script-src 'self'
  https://esm.sh 'unsafe-inline'; …; frame-ancestors 'none'; form-action
  'self'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Robots-Tag: noindex` on preview/version hosts. App hosts never read the
  dashboard session and never set a dashboard cookie. A malformed `Host` is a
  400.
- **The dashboard never serves an app** and refuses mutating requests (POST,
  PUT, PATCH, DELETE) whose `Origin` is an app host, `null` or a foreign site
  with **403** (`/oauth/token`, `/oauth/register` and `/mcp` are exempt — they
  are cross-origin by design and cookie-less). This also applies to the BFF
  proxy route: an app page can no longer call it with the dashboard session.
- **Password gate:** `apps.visibility` is now `public | password`. A password
  app answers 401 with a form on every host; `POST /__drobek/password` (10
  attempts per 15 min per app + IP) sets `__Host-drobek_app_access`
  (host-only, `Secure`, `HttpOnly`, `SameSite=Lax`, 12 h; plain-http dev:
  `drobek_app_access` without `Secure`), an HMAC token bound to the app and
  signed with a key derived from `DROBEK_MASTER_KEY`.
- **New MCP tool `publish(app_id, version?)`** — scope `publish`, editor+,
  annotations destructive + open-world; the default is the newest version that
  compiled, an older one is the production rollback; a version that did not
  compile → `not_publishable`. Audited as `app.publish`; returns
  `{ published_version, previous_version, published_url, domains }`. No
  write lease (it only moves the published pointer). `tools/list` now has
  seven tools; the briefing, `/llms*.txt`, the `build-an-app` prompt and the
  skill say to publish only when the user explicitly asks.
- **Migration `0010_apps_origin`**: the `app_visibility` enum becomes
  `public | password` (existing `team` apps become `password` — with no
  password set they stay closed until an owner sets one) and adds the
  nullable `apps.frame_ancestors` (`'self'` or up to 10 http(s) origins,
  space-separated; anything else falls back to `'none'`).

### ⚠️ Breaking: the MCP tool set is replaced — create_app + write tools (NSO-283)

The MCP server now exposes exactly **six tools** (new package
`@drobek/mcp`; `@drobek/oauth` keeps the transport, sessions and auth):

| Tool | Scope | Annotations |
| --- | --- | --- |
| `list_apps` | read | readOnly |
| `create_app` | write | not read-only, not destructive |
| `get_app` | read | readOnly |
| `read_file` | read | readOnly |
| `write_files` | write | destructive |
| `restore_version` | write | destructive |

- **Removed from MCP:** `whoami` (its answer is part of `list_apps`),
  `collection_define`, `record_create` / `record_read` / `record_update` /
  `record_delete` / `record_query`, `app_errors`, `app_logs`, and the
  `add-data-to-app` prompt (replaced by `build-an-app`). The data and insights
  packages stay — the dashboard still uses them. Agents configured against the
  old tools must be updated; `publish` unlocks no tool until M0-06.
- **Apps are addressed by `app_id`** and every call is authorized against the
  app's workspace (viewer+ reads, editor+ writes, super-admin everywhere; a
  foreign or missing app is the same `not_found`).
- **`create_app`** derives the slug from `name` (a free `-xxxx` suffix when
  taken) and stores version 1 from the `react-ts` template (pinned React
  import map) or the `html` template, compiled; it returns the briefing.
- **`write_files`**: 1–20 changes → validate → secret scan → compile → one new
  version (`compile_status` ok | error; sources are kept either way, built
  outputs only when ok) → a Redis `drobek:app-changed` message (cache bust
  for M0-06). A credential in a file is refused with `secret_in_source` and
  nothing is stored.
- **Single-writer lease** `drobek:applock:<app_id>` (3 min, renewed by every
  write): another user gets `app_locked` with the masked holder and
  `expires_at`; the same user's other sessions take it over.
- **`read_file`** output is marked `untrusted: true` and wrapped in an explicit
  untrusted envelope.
- **Errors** are `{ code, message, hint }` (was `{ error, message }`), with the
  hints from the rewritten error catalogue.
- **New config `APPS_DOMAIN`** (+ optional `APPS_URL_SCHEME`): the host apps
  live under — `<slug>.<APPS_DOMAIN>`, preview `<slug>--preview.<APPS_DOMAIN>`.
  Required in production (the server refuses to start without it); dev default
  `apps.localhost:3041` over http.
- **Migration `0009_app_name`** adds the nullable `apps.name` (additive).

### ⚠️ Breaking: user-bound MCP tokens, new scopes, CIMD (NSO-282)

Core migration **`0008_user_bound_tokens`** makes every MCP credential belong
to a **user**, not a workspace. It runs automatically on server start and is
**destructive by design**:

- **Deleted:** every OAuth authorization code, access token and refresh token
  (`TRUNCATE`) — each connected agent must reconnect once and go through the
  consent screen again. Registered clients are kept.
- **Dropped columns:** `workspace_id` and `role` on `oauth_authorization_codes`,
  `oauth_access_tokens` and `oauth_refresh_tokens`. Access is now decided **per
  tool call** from the user's current memberships (super-admins reach every
  workspace); an unknown workspace, a workspace the user is not a member of and
  a missing app all answer the same `not_found`.
- **New scopes** `read` / `write` / `publish` replace the old vocabulary
  everywhere (AS metadata, consent, tokens, docs). The consent screen has no
  workspace picker any more — only the three checkboxes; the grant is the
  checked ∩ requested scopes, and an empty grant is a denial. `tools/list`
  shows only the tools the grant allows (one tool→scope table):
  `read` = `whoami`, `list_apps`, `record_read`, `record_query`, `app_errors`,
  `app_logs`; `write` = `collection_define`, `record_create`, `record_update`,
  `record_delete`; `publish` = no tools yet; `whoami` is always available.
- **`whoami`** now lists all of the user's workspaces with roles;
  **`list_apps`** spans every workspace, with an optional `workspace` filter.
- **CIMD:** an `https` `client_id` URL is a Client ID Metadata Document,
  fetched through the proxy SSRF guard (https only, default port, 64 KiB,
  5 s, no redirects, cached 1 h in Redis); its `client_id` must equal the URL
  and its `redirect_uris` pass the DCR policy. Any failure is `invalid_client`,
  shown, never redirected. AS metadata advertises
  `client_id_metadata_document_supported: true`. New columns
  `oauth_clients.source` (`dcr` / `cimd`) and `oauth_clients.last_used_at`.
- **DCR limits:** 10 registrations per IP per hour (→ `429 rate_limited`), and
  at most 500 never-authorized clients (`OAUTH_DCR_MAX_UNUSED_CLIENTS`; stale
  ones older than 24 h are pruned, otherwise `503`).
- **RFC 9207:** every authorization response carries `iss`
  (`authorization_response_iss_parameter_supported: true`).
- **Audience:** the resource server accepts only tokens whose resource is the
  MCP URL (else `401 invalid_token`); `/oauth/authorize` with a foreign
  `resource` answers `invalid_target`.
- **API keys:** new table `api_keys` (only the SHA-256 is stored). A
  `drk_…` bearer takes the same resource-server path as an OAuth token;
  revoked → `401`. Create one with
  `task api-key:create EMAIL=… [NAME=…] [SCOPES=read,write]`.
- **New config:** `OAUTH_DCR_MAX_UNUSED_CLIENTS` (default 500) and the
  dev-only `OAUTH_CIMD_DEV_ORIGINS` (exact origins allowed over http / on a
  private address for local CIMD mocks; ignored in production).

### ⚠️ Breaking: the upload/deploy pipeline is gone — apps are versions now (NSO-281)

Core migration **`0007_app_versions`** replaces the deploy pipeline with
immutable app versions. It runs automatically on server start and is
**destructive by design**:

- **Dropped tables:** `deploys`, `deploy_files`, `blob_refs` and the old
  metadata-only `blobs` table; **dropped enums** `deploy_state`, `routing_mode`;
  **dropped columns** `apps.active_deploy_id`, `apps.routing_mode`,
  `apps.uses_end_user_auth`. Deploy history is **not** migrated (decided in
  the M0 plan) — back up the database first if you want to keep it.
- **New tables:** `blobs` (sha256 → `bytea`, deduplicated across versions and
  apps), `app_versions` (numbered per app, author kind, reasoning, compile
  status/errors), `version_files` (path → blob, `source` or `built`), and
  `apps.published_version_id`.
- **App slugs are now globally unique** host labels: 3–40 characters of
  `^[a-z0-9]+(-[a-z0-9]+)*$`, no reserved word (`www api mcp preview admin
  mail static app auth oauth`). The migration renames any existing slug that
  breaks the grammar, is reserved, or collides with an older app's slug in
  another workspace to `<slug>-<4hex>` (the oldest app keeps a contested
  slug). Kept: apps, collections, documents, error/stat signals, upstreams and
  the audit log.
- **Removed:** `@drobek/deploy`, the MCP tools `deploy_init`,
  `deploy_commit`, `deploy_status`, `rollback`, the routes `/__upload/:token`,
  `/__blob/:sha256`, `/api/deploys/:id/events`, `/:ws/app/:slug/*` (incl. the
  REST data endpoints and the error beacon on the dashboard host), the MCP
  prompt `deploy-this-project`, `scripts/sign-upload.mjs` / `task blob:sign`.
- **Removed config:** `UPLOAD_SIGNING_SECRET`, `BLOB_DIR`, `DEPLOY_MAX_*`,
  `DEPLOY_WORKER_CONCURRENCY` and the `drobek_blobs` volume. The old blob
  directory is no longer read — delete it once you no longer need it.
- **New:** `@drobek/apps` (`createApp`, `createVersion`, `getVersion`,
  `listVersions`, `publish`, `restore`, hourly blob GC with a 7-day grace
  period under a Redis lease). The dashboard shows each app's version history
  and lets an editor publish a version (publishing an older one is the
  rollback); `app_logs` reports recent versions instead of deploys.

### One process, one image (NSO-279)

`apps/web` + `apps/mcp-server` + the worker became one `apps/server` process
and one image `ghcr.io/freema/drobek`; the server migrates the database on
start and refuses to boot with placeholder secrets.

### `@drobek/compile` (NSO-280)

In-process esbuild compiler for app sources (virtual file system, import map
from `drobek.json`, limits, secret scan).
