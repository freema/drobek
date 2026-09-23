# Planning prompt — "Make small static drobek apps visible to Google"

> **What this is:** a self-contained briefing to hand to **Fable (`claude-fable-5`)** for a deep planning pass on drobek's SEO / Google-visibility design.
> **How to use:** run Fable in the `drobek` repo (or paste this whole file). Ask it to **plan, not implement**. Everything it needs is below; canonical spec = `docs/ARCHITECTURE.md`, `docs/TECHNICAL_DESIGN.md`, and the Linear project **drobek** (team PhysioHub, key `PHY`).
> **Status when written:** spec audited, decisions ratified, docs reconciled — at the Phase 0 gate. **No code written yet, and we do not want code yet.** We are deliberately thinking this through before building the M1a serving layer.

---

## 0. Your role

You are a **principal engineer + SEO/platform architect** doing a design pass for drobek. You are NOT writing code. You are producing a **decision document**: resolve the open design questions below, challenge the assumptions we've already made, and hand back a plan that a solo founder can execute later without rework.

Bias: **keep drobek small.** The owner has repeatedly rejected "balast" (bloat) — e.g. said no to MinIO, no to a server-side OG-image compute service. Your job is to make small static apps *findable by Google* with the **least machinery possible**, not to turn drobek into Vercel/Netlify. When in doubt, prefer "the vibecoder's build produces the artifact, drobek just serves it faithfully" over "drobek does clever things server-side."

---

## 1. What drobek is (condensed)

drobek = an **open-source platform that hosts small, client-side static (HTML/JS/CSS) "vibecoded" micro-projects**. Drop a folder → live URL. The headline is **MCP-native deploy**: the AI agent that built the app also deploys it (3 MCP tools: `deploy_init` / `deploy_commit` / `deploy_status`). On top of hosting, drobek gives those static apps a **Data API** (jsonb collections + required JSON Schema), a **JS SDK** (data + end-user auth), and an **outbound proxy** (BFF with envelope-encrypted secrets). Open-core: public engine `drobek` (AGPL/dual-license) + private `drobek-web` (SaaS: billing, custom domains, notifications, marketing).

**Stack (mirrors `puls-mcp`):** Node + Remix / React Router v7 SSR · Postgres (source of truth) + Redis (required: BullMQ queue, cache, sessions, rate-limit, live-progress) · monorepo (pnpm) `apps/web` + `apps/mcp-server` + `packages/{db,core,sdk}` · Drizzle ORM · CI GitHub Actions → GHCR → single VPS · self-host = docker-compose + `.env`. **Single box, one region.**

**Serving model (today's spec):**
- `apps(… routing_mode 'spa'|'exact', visibility 'public'|'team'|'password' …)`.
- Serving resolves `deploy_files[active_deploy_id][path]`, or SPA-fallback `index.html`. Bytes live as content-hash blobs on **local disk** (`BlobStore`), `ETag = sha256`, immutable caching for hashed assets.
- Deploy pipeline: **strict lint (no chromium), no server-side build** — the agent builds `dist/` locally and deploys the static output. Immutable deploys, rollback = repoint `active_deploy_id`.
- URLs: static (no-auth) app = **path-based** `<host>/<ws>/app/<slug>`; auth apps = **per-workspace apps-origin** `<ws>.apps.<host>`. Custom domains are a `drobek-web` (Enterprise) module.
- Quotas: ≈ 25 MB / 200 files / 5 MB per file per app.

**Milestones:** M0 (walking skeleton) → **M1a** (auth + workspaces + 4 roles + deploy + serving + dashboard + self-host) → M1b (Data API + MCP CRUD) → M1c (JS SDK + end-user auth) → M2 (full Data API + Proxy) → M3 (full dashboard + drobek-web modules).

---

## 2. Hard constraints (do not violate — these are settled)

1. **No server-side prerender.** The deploy lint explicitly forbids chromium; drobek must **never** render an app to snapshot it. Indexable HTML must come from the vibecoder's own build (Vite SSG / vite-react-ssg / prerender plugin), and drobek serves it faithfully.
2. **Single box, no CDN/edge in v1.** Global TTFB is what it is. Any plan assuming edge rendering or a CDN is out of scope (a custom-domain user can front drobek with Cloudflare themselves — that's the recommended pattern, not a drobek feature).
3. **Keep it small.** No new compute service (no OG-image renderer, no image optimizer) unless you can prove it's essential *and* cheap. Default answer to "should drobek do X server-side?" is **no**.
4. **Static deploy is the only indexable surface.** Content that lives in the Data API is client-rendered and therefore invisible to crawlers, by design. Don't propose SSR-ing Data API content.
5. **Security model stands:** apex same-origin is unsafe with untrusted authors (admin takeover); before multi-tenant, dashboard moves to `app.drobek.app`. Moving apps onto their own subdomain/custom domain *helps* both SEO and this isolation — lean into that convergence.

---

## 3. The problem

> The owner's framing: *"drobek's goal really IS the small things — but it would be good to make those things somehow visible to Google."*

So: a vibecoder builds a small React SPA (or a multi-page static site) and hosts it on drobek. Out of the box a pure client-side SPA renders to an empty `<div id="root">` — **invisible to social-share crawlers (they never run JS) and unreliable for Googlebot (JS rendering is a deferred, best-effort second wave).**

**Design a light, coherent story for "hosted drobek apps are findable by Google and share correctly on social,"** without turning drobek into a heavyweight platform. Resolve the decisions in §5, challenge them, and produce the deliverable in §6.

---

## 4. Concrete case study (anchor your thinking on a real example)

Reference app the owner used as the "typical case": **https://vladcifotbalu.vercel.app/** (a Next.js content/fan site; drobek cannot host Next.js, but a vibecoder could build a very similar React SPA / static site). Profiled via devtools:

- **~170 routes**, homepage ~**217 KB** prerendered HTML, **full SEO** (per-route `<title>`/meta/canonical/OG/JSON-LD, sitemap.xml, robots.txt).
- Uses Next App Router RSC prefetch, SSG, `/_next/image` optimizer, `/api/og` (Satori dynamic OG cards), a newsletter server-action, GTM/GA4/consent.

Prior gap analysis concluded drobek could host **~80%** of this **today** if the app is built as plain prerendered static output. Three gaps ranked:
- **A — prerender/SSG + SEO serving** (biggest; unlocks content sites) → recommended **GO**, cheap.
- **B — OG-image compute** (`/api/og` equivalent) → recommended **DEFER** ("balast," like the rejected MinIO).
- **C — custom domain at root** → already planned in drobek-web; reprioritize.

Use this to sanity-check every decision: "would this let a vibecoder ship a vladci-style site and have Google index it?" But remember the target is **small** apps — a 5-page site is the common case, 170 pages is the upper edge.

---

## 5. Open decisions to resolve (this is the core of your task)

These are the current working positions. **Treat them as a strawman to pressure-test, not gospel.** For each: give a recommendation, the reasoning, the trade-offs, what it costs to build, which milestone it belongs to, and how it could go wrong.

- **D1 — Prerender philosophy.** Proposed: drobek serves prerendered HTML from the build and **never** prerenders server-side. Is "faithful static serving + good routing" genuinely enough for real Google indexing of a small app? What's the minimum the vibecoder must do (which build tool / recipe), and how do we make that a one-line instruction the agent follows?

- **D2 — Routing + real 404 (the crux).** `routing_mode: spa` blindly falls back every path to `index.html` → HTTP 200 for everything → Google sees **soft-404s / duplicate content** and penalizes. Proposed: a **hybrid** — serve the exact file if it exists, SPA-fallback only for *declared* client routes, and return a **genuine 404 (status 404 + `404.html`)** for truly missing paths. **How does drobek know a path is a real route vs missing?** Options: (a) app declares `routes[]` in a manifest / `drobek.json`; (b) file-existence convention (`<path>/index.html` or `<path>.html` exists → 200, else 404); (c) app ships `404.html` and drobek serves it with 404 for unmatched. Pick one, justify it. Also decide trailing-slash canonicalization (`/about` vs `/about/` vs `/about.html` → one canonical form + 301).

- **D3 — Indexability is a property of the domain (the opinionated one — challenge hard).** Two structural facts push here: (1) a path-based app at `drobek.app/<ws>/app/<slug>/` **cannot own `/robots.txt` or `/sitemap.xml`** (those belong to the drobek.app root), so it structurally cannot do proper SEO; (2) thousands of indexable junk apps under one apex risks Google flagging **`drobek.app` itself** as a thin-content / spam farm (cf. the SEO reputation collapse of old free hosts). Proposed policy: **free path-based apps default to `noindex`**; real indexability (own robots/sitemap/canonical) is unlocked only on a **per-app subdomain or custom domain.** Is this right? Is it too restrictive for the "small things visible to Google" goal, or exactly the correct guardrail? What's the cleanest default that protects the platform's own domain reputation without making the free tier feel crippled? Consider `noindex` default + easy upgrade path.

- **D4 — SEO/content boundary.** State plainly (and place in docs): **indexable = what's in the static deploy; Data API content is not indexable.** Is there any lightweight exception worth supporting (e.g. a build-time data fetch that bakes content into files at deploy)? Or is that already just "the vibecoder's build problem"?

**Smaller, cheap value-adds — decide GO/DEFER and sequence, don't over-invest:**
- Auto-generate `sitemap.xml` from the deploy manifest (subdomain/custom-domain only).
- **IndexNow / sitemap ping on deploy** (`metrifyr` already exposes `indexnow_submit`; it's one HTTP POST → "deploy = immediately submitted to search engines"; needs a domain-level key, so custom-domain only). Is this a differentiator worth an M-slot, or backlog?
- Serving hygiene for Core Web Vitals: brotli/gzip, faithful untouched `<head>`, HTTP caching. What's the minimum bar?

**Known limitation to record (not a task — confirm it's acceptable):** single-box, no CDN → TTFB/LCP for distant users hurts ranking; recommended mitigation is "custom domain + Cloudflare in front," documented, not built.

---

## 6. Deliverable (what to hand back)

Produce a **decision note** (markdown, fits alongside `docs/ARCHITECTURE.md`) with:

1. **Verdict per decision** D1–D4 + each value-add: recommendation, 2–4 sentence rationale, trade-offs, rough build cost (S/M/L), target milestone (M1a / M2 / drobek-web / backlog), and a one-line failure mode.
2. **The one-paragraph "drobek SEO story"** — how you'd explain to a vibecoder, in ~4 sentences, how to make their small app findable by Google on drobek. If you can't make it that simple, the design is too heavy — say so.
3. **What M1a's serving layer must support from day one** so D2/D3 don't require a rewrite later (concrete: routing resolution, status codes, headers, the `noindex` toggle, where robots/sitemap live).
4. **A tight proposed ticket list** for the Linear project (team PhysioHub, key PHY, milestones M0/M1a/M1b/M1c/M2/M3), each marked **GO / DEFER / DECIDE**, sized S/M/L. Keep it minimal — prefer 4–6 sharp tickets over a sprawling backlog. Do **not** create the tickets; just propose them.
5. **Assumptions you challenged** — explicitly call out anything above you think is wrong, especially D3.

### Guardrails
- **No code.** No implementation, no file scaffolding. Design and decisions only.
- **Don't scope-creep drobek into a general web host.** Every "yes" must survive the "is this balast?" test.
- **Be decisive.** Give a recommendation, not a survey. If you'd defer something, say defer and why — the owner values a clear go/no-go over exhaustive options.
- **Tie everything to milestones and the small-first philosophy.** The measure of success is: a vibecoder ships a small static app, and Google + social crawlers see it — with drobek having added the least machinery necessary.
