# drobek — Deep analysis

> Honest, detailed read of the whole project: completeness, M1a build breakdown, dependencies, risks, effort, and what actually blocks shipping. Draft 2026-06-30. Assumes a **small/solo team**.

---

## 1. Spec completeness scorecard

| Area | State | Notes |
|---|---|---|
| Product concept | ✅ | Clear, validated direction (static + MCP deploy + data + auth). |
| Stack & repo | ✅ | Node/RR7 + PG + Redis; monorepo mirrors puls; Drizzle; GHA→GHCR→VPS. |
| Auth (drobek accounts) | ✅ | Port puls-mcp — biggest de-risk; proven code exists. |
| Workspaces + roles | ✅ | personal+team, 4 roles, invites. |
| Deploy pipeline | ✅ | 3 MCP tools, presigned, BullMQ, lint, content-hash, rollback. |
| Serving + origin | 🟡 | Model decided; **per-workspace apps-origin + wildcard cert ops** not detailed; visibility gate new. |
| Data API | ✅ | jsonb + required schema + REST/SDK + modes. Query semantics indicative. |
| End-user auth | 🟡 | Decided at the design level; **token format, CSRF specifics, OAuth provider config** still to build out (PHY-75). |
| JS SDK + components | 🟡 | Delivery decided; **API surface + component set** not enumerated. |
| Proxy | ✅ | BFF + SSRF guard + envelope secrets. |
| drobek-web modules | 🟡 | Tiers/billing/marketing/notifications/feedback scoped, not specced in depth. |
| Ops (logger/Sentry/metrics) | ✅ | Decided. |
| Self-host | ✅ | compose + .env. |
| Security (threat model) | 🔴 | **Not done** (PHY-76). Largest unaddressed risk area. |
| Abuse/phishing | 🔴 | Deferred (PHY-90). Real for public SaaS. |
| Storage GC / binaries / backups | 🔴 | Deferred (PHY-80). |
| GDPR/compliance | 🟡 | Tickets exist (PHY-86/87); not designed. |
| Brand/name | 🔴 | Placeholder. |

**Verdict:** the **build path for M1a is ~fully specified**; most red items are M2+/launch concerns, except the **security threat model**, which should run alongside M1.

---

## 2. M1a — build breakdown

Goal: *deploy a static app from Claude Code → live URL + rollback + dashboard + `docker compose up`.*

| # | Workstream | Tasks | Size | Ticket |
|---|---|---|---|---|
| 1 | **Monorepo scaffold** | pnpm workspace (apps/web, apps/mcp-server, packages/{db,core,sdk}); Drizzle + postgres.js; docker-compose (web/mcp/pg/redis); `.env.example`; base CI (GHA→GHCR) | **M** | PHY-73, PHY-77 |
| 2 | **Auth port** | Lift puls-mcp: email magic-code + Google OIDC + sessions; SMTP; rate-limit (Redis) | **M** | PHY-53 |
| 3 | **MCP OAuth AS** | Port well-known + authorize + token + DCR + PKCE; token validation in mcp-server | **M** | PHY-53, PHY-71 |
| 4 | **Workspaces + roles** | tables + memberships + 4-role enum + `SUPERADMIN_EMAIL` bootstrap + invites (basic) | **M** | PHY-54 |
| 5 | **Deploy pipeline** | `deploy_init` (manifest diff + presign) → upload sink → `deploy_commit` (BullMQ) → lint → blobs → activate → `deploy_status` (SSE) | **L** | PHY-57, PHY-71 |
| 6 | **Serving** | path resolve → active deploy → blob; ETag/cache; CSP/nosniff; SPA fallback; basic visibility gate | **M** | PHY-58 |
| 7 | **Dashboard (minimal)** | login, apps list, app detail (overview + deploys + rollback) | **M** | PHY-62 |
| 8 | **MCP tools** | `deploy_*`, `list_apps` registered + scoped; actionable errors | **S/M** | PHY-71 |

**Rough total:** ~6 **M** + 1 **L** + scaffold ≈ a few focused weeks solo. The **L** is the deploy pipeline (presigned upload sink + job + content-hash store + activation) — the riskiest/most novel; build it first behind a thin CLI before wiring MCP.

---

## 3. Dependencies & critical path

```
scaffold(1) ─┬─▶ auth(2) ─▶ MCP-OAuth(3) ─┐
             ├─▶ workspaces(4) ────────────┼─▶ deploy(5) ─▶ serving(6) ─▶ dashboard(7)
             └─▶ (db/blobs) ───────────────┘            └─▶ MCP tools(8)
M1a ▶ M1b (data API + record_* tools) ▶ M1c (SDK + end-user auth, needs apps-origin + wildcard cert)
M2: full data runtime + proxy ; M3: full UI + ops + drobek-web modules
```

**Critical path:** scaffold → deploy pipeline → serving. Auth can proceed in parallel; MCP tools sit on top of both. **M1c (end-user auth) is gated on the per-workspace apps-origin + wildcard TLS**, which is also infra work — pull that forward if M1c matters early.

---

## 4. Risk register

| Risk | L | I | Mitigation |
|---|---|---|---|
| **M1 scope creep** (already ballooned) | H | H | Hold the M1a line; defer data/SDK/end-user-auth to M1b/c; resist new M1 features. |
| **Security holes** (untrusted JS, end-user sessions, SSRF, secrets) | M | **H** | Run the threat model (PHY-76) alongside M1; serve apps off the admin origin; never trust client. |
| **Solo-dev bandwidth** vs scope (~40+ tickets) | **H** | H | Ruthless milestone discipline; ship M1a as a real, dogfoodable thing before M2. |
| **End-user auth on shared origin** done wrong | M | H | Per-workspace apps-origin decided; verify token isolation before M1c. |
| **Self-host SMTP deliverability** (magic-link breaks) | M | M | Console/dev transport fallback; clear SPF/DKIM docs; Resend default for SaaS. |
| **Wildcard TLS + apps-origin ops** complexity | M | M | DNS-01 wildcard once; document; only needed when auth apps ship. |
| **MCP file transfer pain** (presigned plumbing) | M | M | Prototype the upload sink first; fallback inline for tiny text. |
| **Incumbents ship MCP deploy** (Vercel/Replit) | M | M | Lean into self-host + company-internal + data/auth bundle (see positioning). |
| **Abuse/phishing on public SaaS** | M | M | PHY-90 before public launch; internal self-host lower risk. |
| **Required-schema friction** vs vibe ethos | L | M | Agent defines schema; good DX; revisit if it bites. |

---

## 5. Effort & sequencing reality check

This is a **broad product** (hosting + BaaS + auth + proxy + SaaS). Realistically:
- **M1a** = a few weeks of focused solo work (auth port is the shortcut).
- **M1b+M1c** roughly double that (data API is moderate; end-user auth + SDK + components is the bigger chunk).
- **M2/M3** are large (full UI, proxy, ops, drobek-web business).

**Recommendation:** treat **M1a as a public milestone** — ship it, dogfood it (deploy your own demo), *then* decide M1b vs polish based on real usage. Don't build M2/M3 on paper.

---

## 6. What actually blocks M1a (vs deferrable)

**Blocks M1a:** monorepo + Drizzle + compose; auth port; deploy pipeline; serving; minimal dashboard. (All specified.)
**Deferrable past M1a:** data API, SDK, end-user auth, proxy, visibility modes beyond public, metrics, drobek-web modules, threat-model doc (start it, don't gate on it), brand.

**Smallest decisions still open that touch M1a:** SPA-fallback default (pick **on**), blob storage = PG for now (binaries later), preview deploys (defer).

---

## 7. Recommendations

1. **Scaffold M1a now** (mirror puls); get `docker compose up` green with empty apps.
2. **Build the deploy pipeline first** behind a tiny script, then wire MCP — it's the riskiest piece.
3. **Port auth in parallel** (lowest risk, known code).
4. **Start the threat model doc** as you build (don't gate).
5. Keep the M1a line; everything else is backlog.
6. Decide the **brand/name** before the public OSS push (package names, marketing).

> Positioning analysis (vs Vercel/Netlify/Supabase/Replit/Bolt/Lovable) lands in `docs/POSITIONING.md`.
