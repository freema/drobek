# drobek — Positioning

> Competitive landscape, USP, target, messaging, risks, and the strategic implications for the spec. Based on market research 2026-06-30.

## 1. Landscape

| Category | Players | Relevance |
|---|---|---|
| Static / edge hosts | GitHub Pages · **Netlify** (official MCP) · **Vercel/v0** · **Cloudflare Pages/Workers** | Publish public sites; no bundled per-app data/auth/UI; not self-hostable. CF **Workers for Platforms** = the "host untrusted AI code multi-tenant" primitive to watch. |
| BaaS / data layer | **Supabase** · **Appwrite** · **PocketBase** | Self-hostable backends — but *backends*, not MCP-deploy app hosts. **PocketBase** is the closest analog (binary: collections+schema+auth+SDK+admin, serves static). |
| AI app builders | **Replit/Agent** · **Bolt.new** · **Lovable** · **GitHub Spark** | Build + (mostly) host in one flow — but **all closed SaaS**; Spark is GitHub-locked; Bolt doesn't deploy. |
| MCP-native deploy (direct rivals) | **AppDeploy** · **Bonto** | "Deploy from Claude/Cursor → live URL" + DB/auth/storage. Closest conceptually — but closed, public-app-oriented. |

## 2. USP (honest)

**The moat is the intersection, not any single feature:**
1. **Self-host + AGPL × MCP-deploy-with-data-layer.** Every workflow rival (Replit, Lovable, Spark, AppDeploy, Bonto, Netlify, Vercel) is **closed SaaS**; every self-hostable rival (PocketBase, Supabase) **isn't an MCP app host**. drobek is the only product on **both** axes.
2. **The complete bundle around the "tiny static app"** — host + jsonb collections/schema + end-user auth SDK + drop-in UI components + outbound proxy to company backends + forms + inbound webhooks + dashboard.
3. **Company-internal fleet management** — a sanctioned home for the *hundreds* of micro-apps an org vibecodes, with shared internal auth + audit + a dashboard.

**Be honest about what is NOT a moat:**
- MCP "paste & it's live" deploy is **table stakes** (Netlify/Vercel/AppDeploy/Bonto already have it).
- The data API + auth is **more mature in PocketBase/Supabase**.
- Proxy / forms / webhooks are each individually trivial.
→ **The bundle + self-host + governance is the value. Don't market the deploy; market the sanctioned internal fleet.**

## 3. Target & messaging

**Buyer:** platform / IT / internal-tools leads at mid-size+ companies where devs *and non-devs* vibecode lots of throwaway internal tools and need a **governed, on-prem** home (data residency, SSO, audit).
**Secondary:** agencies, internal-platform teams, security-conscious orgs.

**One-liner:** *"The self-hostable home for every tiny AI-built app your team makes — your agent deploys it via MCP, and it gets data, auth, and a dashboard out of the box."*

**Angles:** (a) **"Shadow-IT, sanctioned"** — end the sprawl of random personal Vercel accounts. (b) **"PocketBase's backend meets Netlify's deploy, MCP-native."** (c) **"Your walls or ours"** — AGPL self-host for the security-conscious, SaaS for the rest.

## 4. Risks

- **Incumbent bundling:** Netlify (already MCP) / Vercel add a cheap internal tier + data/auth; they own distribution.
- **Self-host wedge eaten:** PocketBase/Supabase bolt on an MCP deploy front-end → instant credible self-hostable drobek.
- **Cloudflare Workers for Platforms** commoditizes multi-tenant untrusted-app hosting.
- **AppDeploy/Bonto** ship enterprise/self-host.
- **"Good enough" substitution:** one shared PocketBase + CF Pages glued by an agent satisfies most orgs.
- **AGPL aversion** in enterprises pushes them to SaaS, eroding the self-host edge.

## 5. Strategic implications for the spec

1. **Lean into the moat → prioritize the bundle + self-host + governance**, not the deploy. The deploy is necessary but not the story.
2. **Governance features are differentiators, not chores:** roles, audit log, proxy (data stays internal), team-only visibility, SSO. Pull these *up* in priority for the company-internal pitch.
3. **PocketBase is the bar for the data/auth layer** — don't out-engineer it; match its simplicity, win on integration + hosting + governance.
4. **Self-host must be genuinely easy** (`docker compose up`) — it's the whole differentiator; protect it (Redis/PG only, no cloud lock-in, clear docs).
5. **Reconsider AGPL vs the enterprise buyer** — AGPL protects against SaaS rivals but repels legal-averse enterprises; the open-core split (private drobek-web) softens this, but verify the buyer is OK with AGPL self-host.
6. **Don't over-invest in public-SaaS growth features early** (gallery, marketplace) — the wedge is *company-internal*, where rivals are weakest.
7. **Speed matters:** AppDeploy/Bonto exist; the self-host+governance niche is open *now*. Ship M1a, dogfood, target one design-partner company.
