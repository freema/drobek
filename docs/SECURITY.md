# Security

## Reporting a vulnerability

Report vulnerabilities in drobek privately through GitHub's **private
vulnerability reporting**:
<https://github.com/freema/drobek/security/advisories/new> (Security tab →
"Report a vulnerability"). Please do not open a public issue for a security
problem. Include the affected version (`GET /api/version` → `{ sha, version }`)
and the steps to reproduce; a proof of concept against your own instance is
welcome, against someone else's is not.

drobek is maintained by one person; expect an acknowledgement within a few
days. Fixes ship as a new release (`vX.Y.Z`, see
[`SELF-HOSTING.md`](./SELF-HOSTING.md) → Upgrades) with a `CHANGELOG.md`
entry.

**Not a vulnerability report?**

- Abuse of an app **hosted on** a drobek instance (phishing, malware, spam):
  use that instance's report form — every app host links it at
  `/.well-known/drobek-report`. It reaches the instance's operator, not the
  drobek project.
- A self-hosted instance is run by its operator (the addresses in its
  `SUPERADMIN_EMAIL`), not by the drobek project.

## Threat model

The design goal that shapes everything below: **drobek never executes app
code.** It compiles what an agent writes and serves the output to browsers;
an app's backend is platform modules the operator installed. That removes
the whole class of sandbox problems (escape, egress control, supply chain of
app dependencies on the server, secrets in a sandbox's environment). What
remains is a web platform that hosts untrusted front-end code next to a
dashboard that holds real credentials.

Actors: the **operator** (runs the instance, installs modules — trusted);
**workspace members** (admin / editor / viewer); their **agents** (act with
the member's grant; everything they read from apps can be hostile);
**app authors** (any member with the editor role — untrusted code);
**end users** of apps and **anonymous visitors** (untrusted input).

| Area | Threat | What drobek does (server-enforced) |
| --- | --- | --- |
| **Origin split** | App JavaScript steals the dashboard session or OAuth tokens; apps attack each other | Apps are served only on the apps origin (`APPS_DOMAIN`, a separate registrable domain recommended), each app on its **own host** = own origin (`<slug>`, `<slug>--preview`, `<slug>--v<N>`). The dashboard host never serves an app file. Dashboard cookies are `__Host-` (host-only, `Secure`, path `/`) in production and never read on the apps origin; the serving handler reads only its own app-access cookie. App CSP: scripts and `connect-src` only `'self'` + esm.sh, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors` = the dashboard origin (owner override per app adds origins), `form-action 'self'`; `nosniff`, `Referrer-Policy: no-referrer`, `noindex` on preview/version hosts. A module response can only add a stricter CSP as a second policy: uploaded files (the `files` module, types sniffed from the bytes, SVG/CSV as attachments) also carry `Content-Security-Policy: sandbox`, except PDF. |
| **App thumbnails in the dashboard** | Framing an app turns the dashboard into a clickjacking surface or lets app code reach the dashboard | The workspace app list is the only place the dashboard frames an app, and the app hosts allow exactly one extra ancestor for it: the dashboard origin (`PUBLIC_APP_URL`), no other site. The iframe is `sandbox="allow-scripts allow-same-origin"`: the app keeps its own origin, which by the origin split is never the dashboard's, so it cannot touch the dashboard's DOM or cookies; without `allow-top-navigation`, `allow-popups`, `allow-forms` or `allow-modals` it cannot navigate the dashboard, open windows, submit forms or show dialogs. It is `credentialless` where the browser supports it (a throwaway cookie and storage partition, so the preview never runs as the viewer's end-user session), lazily loaded, sent no referrer, and inert (`pointer-events: none`, no focus, `aria-hidden`): nothing in it can be clicked. A password-gated, taken-down, inactive or never-compiled app gets a placeholder tile instead. Like any visit, a thumbnail load runs the app's start-up code and counts in its request stats. |
| **CSRF on the dashboard** | A page (or an app) makes the member's browser mutate the dashboard | Every mutating dashboard request passes the origin check (`@drobek/auth` `origin-check.ts`): an app host, `null` or a foreign `Origin` → 403. The module confirm/reject API requires an `Origin` equal to the dashboard origin. |
| **End-user sessions** | An app rides another app's session; tokens in `localStorage` | No tokens in JavaScript: the end-user session is an HttpOnly, host-only cookie on the app's own host (`__Host-drobek_eu`), resolved by core into `ctx.principal`. Mutating module calls need the app's own origin and `X-Drobek-SDK: 1` (`csrf_rejected`). The owner can end every session of an app at once (per-app epoch) or block one user (effective on the next request). |
| **Access rules** | An app or agent reads or writes data it should not; the dashboard session used as a confused deputy | One rules evaluator for every module (`public` / `user` / `owner` / `admin` per operation); the principal comes only from the end-user session; `app_id` and the record owner are set by the server. Quotas and rate limits hold regardless of the rules. An agent's change that opens access (a rule to `public`, a new recipient, an upstream for an app) is stored **pending** until the owner confirms it in the dashboard; proxy changes need a **workspace admin**. |
| **Secrets** | A secret passes through the LLM, a log or a response | Secret values are entered only in the dashboard, write-only, and stored AES-256-GCM envelope-encrypted under `DROBEK_MASTER_KEY`; MCP and the dashboard show names and `hasSecret` only. Every `write_files` and `configure_module` payload is scanned for credential patterns and refused, nothing stored (`secret_in_source` for files, `invalid_params` for a module config). The proxy injects the secret server-side. Beacon and log entries are redacted. The server refuses to start with a missing, all-zero or `change-me` master key or a weak `TLS_ASK_TOKEN`. |
| **Compilation** | Escaping the virtual filesystem (`import '/etc/passwd'`), network at build time, DoS by input size | esbuild runs over an in-memory file map; the resolver plugin never touches the disk; bare imports resolve only through the app's import map to `https://` URLs marked external (the server never fetches them). Limits: 200 files, 512 KiB per file, 5 MiB per version, import depth 50, 10 s per build (cancelled), 4 concurrent builds + a bounded queue (`busy`). The output is never executed on the server. |
| **Prompt injection through tool output** | A file, a record or a log line carries instructions for the agent | `read_file`, `query_data` and `get_logs` return their content inside `<untrusted-app-file>` / `<untrusted-app-data>` / `<untrusted-app-logs>` envelopes whose closing marker carries a random per-response nonce, after a line stating it is data; these three tools answer that text only, with no `structuredContent` that a client could hand to the model past the envelope; the briefing and skills repeat the rule. The beacon accepts only same-origin reports, caps them at 8 KiB and rate-limits per app and per IP. |
| **MCP / OAuth** | Token replay, wrong audience, DCR floods, phishing clients | Tokens are bound to the user and to the audience = the MCP endpoint (RFC 8707); membership is checked on every call (a non-member gets `not_found`). PKCE S256, exact redirect URI match, RFC 9207 `iss`, refresh rotation with reuse detection (a reused refresh token burns the lineage). DCR: 10 registrations per IP per hour, at most `OAUTH_DCR_MAX_UNUSED_CLIENTS` clients that never got consent. Client ID Metadata Documents are fetched through the SSRF guard (https, ≤ 64 KiB, 5 s, no redirects, cached). `drk_` API keys are stored as hashes, shown once, revocable; OAuth connections are revocable at `/me/connections`. `/mcp` bodies are capped at 512 KiB. |
| **Authorization-code replay / PKCE brute force** | A stolen authorization code is replayed, or its `code_verifier` guessed over many exchanges | Codes are single-use, live 5 minutes and are stored as hashes. The first exchange of a code consumes it whether it succeeds or fails (wrong verifier, redirect URI or client, expired), so a verifier gets one try. Presenting a consumed code again revokes the refresh-token lineage it was exchanged for and the grant's access tokens (the refresh-reuse mechanism). |
| **Dashboard sign-in** | Brute-forcing e-mailed codes, mail bombing | Five guesses per code (atomic counter, then the code is destroyed), a per-IP verify limit, per-IP / per-address send limits with a cooldown, a global hourly brake and a kill switch (`OTP_*`). Without a trustworthy client IP the per-IP buckets are skipped rather than shared. |
| **SSRF** | The proxy module or the CIMD fetch reaches the internal network or cloud metadata | DNS resolved once and the connection pinned to that IP; private and reserved ranges blocked (unless the operator lists a hostname in `PROXY_ALLOWED_HOSTS`); ports 80/443 only (`PROXY_ALLOWED_PORTS`, checked at registration and at connect); no redirects followed; 20 s deadline, 5 MiB response cap (also for a decoded gzip/br body); at most `PROXY_MAX_CONCURRENT` calls in flight (`PROXY_MAX_CONCURRENT_PER_APP` per app). The forwarded path is checked on its fully decoded form — no `..`, encoded `/`, `\` or control character behind any depth of percent-encoding — and must stay under the upstream's base path and allowed prefixes; only allow-listed response headers (no `Set-Cookie`, CORS grants, `Clear-Site-Data`, `Link`, HSTS or absolute `Location`) reach the app origin. Upstreams are registered by workspace admins, and an app may use one only after an admin confirmed that upstream record (`allowed_app_ids` + the record id in the app's config). |
| **Spam** | Forms, sign-in codes or notifications used to send mail through the instance | Apps can never mail an arbitrary address: notifications go only to the app's owners, sign-in codes only to allowed addresses. Forms have a honeypot, an HMAC time token and per-IP / per-app limits. The operator-wide mail guard splits an hourly budget into sign-in codes and notifications with a per-app share of each; a class past its budget pauses (the other keeps working) and logs an `email_global_pause` ALERT line. |
| **Resource exhaustion** | Many versions, big apps, floods of unknown hosts or beacons | Compile limits; a 256 MiB byte LRU for serving; module quotas and rate limits (`DATA_*`, `FILES_*`, `FORMS_*`, `PROXY_*`, `AUTH_*`); per-app and per-IP beacon limits; unknown app hosts are negatively cached for 30 s and limited per client IP (`APPS_UNKNOWN_HOST_*` → 429). An answer sent before a request body fully arrived (a 413 mid-upload) closes the connection instead of draining the rest; a module request body must arrive within `APPS_MODULE_BODY_TIMEOUT_MS` (408). The files sweep removes a deleted app's uploads, unreferenced blobs and stale temp uploads (`FILES_SWEEP_*`). |
| **TLS issuance abuse** | Arbitrary SNI names make Caddy order certificates | On-demand issuance always asks drobek first; the `ask` endpoint answers only on the internal address with the token, and says 200 only for hosts of live apps and verified custom domains. Custom domains need a TXT proof and are re-checked daily. |
| **Client IP spoofing** | Forged `X-Forwarded-For` / `X-Real-IP` defeats per-IP limits; clients without a resolvable IP lock each other out | Behind the bundled Caddy (`TRUST_PROXY=x-real-ip`) only the `X-Real-IP` Caddy sets from the TCP peer is trusted. Every per-IP limit (sign-in, DCR, the password gate, module `per: 'ip'` routes, public proxy upstreams, beacons, abuse reports) needs a resolved client IP: a request without one gets no per-IP bucket — never a shared one — and a warning is logged once per bucket; the per-code, per-address, per-app and per-user limits still apply, and the password gate keeps a per-app cap on attempts. |
| **Abuse: phishing / malware hosting** | Someone publishes a fake bank login | Apps live on the apps origin, not the dashboard's. Every app host answers `/.well-known/drobek-report` and sends `X-Drobek-App: <slug>`; the public report form is rate-limited and e-mails the super-admins. A super-admin **takedown** unpublishes and locks the app: 451 on every host, every agent write refused (`app_locked_by_admin`), the owners told. A publish heuristic (password field + a brand word) files a report without blocking. |
| **Public gallery** | An agent or a stranger exposes someone's app publicly; the list leaks who owns what; scraping | Off unless the operator sets `GALLERY_ENABLED`. Only an editor+ of the app's workspace lists it, and only a published app; over MCP the tool needs the `publish` scope and `user_confirmed: true`, which the tool description allows only after the user's explicit yes. `GET /api/public/gallery` returns name, description (plain text, control characters stripped, ≤ 160 characters), production URL and publish time — never an e-mail, workspace, user or app id (the cursor carries the publish time and the slug only). It filters at query time, so unpublish, takedown, delete or a super-admin's hide remove an entry with the next request; read-only, CORS `*`, per-IP limit, 60 s public cache. No screenshots: the server never runs app code. |
| **Third-party modules** | A malicious module | A module is a server-side dependency the operator installs, trusted like any other dependency; app authors can never install one. The module context is app-scoped. Install only modules you trust. |
| **Audit** | Covering tracks | The audit log is append-only; the only deletion is the age-based retention prune (`AUDIT_RETENTION_DAYS`, default 365), never exposed over an API. |

### Status of the 2026-07 review (PHY-76)

The pre-rebuild review is archived at
[`archive/threat-model-phy-76.md`](./archive/threat-model-phy-76.md). Its
findings today:

| Finding | Status |
| --- | --- |
| HIGH — OTP code lockout non-atomic, no verify-side limit | fixed: atomic per-code counter (5 guesses) + per-IP verify limit |
| HIGH — apps same-origin with the dashboard | fixed: the apps origin, one host per app, `__Host-` dashboard cookies, origin check |
| MEDIUM — confused deputy through the dashboard session | fixed: module routes see only the end-user principal; the dashboard session never exists on app hosts |
| MEDIUM — spoofable `X-Forwarded-For` | fixed: `TRUST_PROXY=x-real-ip` behind Caddy; no shared bucket for unknown IPs |
| MEDIUM — CSV formula injection | fixed: every CSV export goes through one writer that neutralizes formula triggers (`@drobek/core` `csv.ts`) |
| LOW — unlimited DCR | fixed: per-IP limit + unused-client cap; CIMD preferred |
| LOW — placeholder secrets accepted | fixed: fail-closed start |
| LOW — app-access cookie survives a password change | **open**: the unlock cookie is a stateless HMAC token valid for 12 h; changing an app's password does not revoke cookies already issued |
| LOW — proxy to any port | fixed: ports 80/443 only |
| LOW — beacon poisoning | fixed: same-origin beacon on the app's own host, size caps, per-app and per-IP limits |

### Known limitations

Stated plainly so operators can plan around them:

- **No per-token rate limit on `/mcp` itself.** Calls are bounded by the body
  cap, the compile queue (`busy`), the single-writer lease and the per-feature
  limits.
- **App-access cookies** of password-protected apps stay valid for up to 12 h
  after a password change (see the table above).
- **Client IP behind another proxy:** with a CDN, load balancer or host proxy
  in front of Caddy, every client shares that proxy's IP for the per-IP
  limits; IPv6 clients on a Docker host without IPv6 can all appear as the
  bridge gateway.
- **Sessions are in Redis**, which `task backup` does not include: a restore
  on a new machine signs everyone out (API keys and OAuth clients survive).
- The operator of an instance can read everything stored on it (records,
  submissions, uploads); secrets are encrypted at rest but the process can
  decrypt them. Choose your host accordingly.
