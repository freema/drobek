# drobek — positioning

> The market, how drobek compares, who it is for and what could go wrong.
> Updated 2026-09-24 for the cloud-workspace direction (the agent works
> directly in drobek) and the launch of Macaly Cloud.

## 1. drobek vs Macaly Cloud

Macaly Cloud (team.blue) launched on 2026-09-16 with the same core idea:
connect your own agent over MCP and let it build and host web apps in a
cloud workspace. It is the reference competitor.

| | Macaly Cloud | drobek |
|---|---|---|
| Code | proprietary; US sub-processors (Vercel, Convex, E2B/Freestyle, Code.storage, Clerk) | **AGPL-3.0, complete self-host**: one Node image + Postgres + Redis (+ Caddy for TLS) |
| Where it runs | Vercel fra1 + Convex Ireland, but US companies (CLOUD Act) | **EU operator on an EU VPS** for drobek.app, no US vendor in the hot path — or your own server |
| Security model | a sandbox per app, a `bash` tool, secrets in the sandbox environment | **the server never executes app code** — it compiles and serves; secrets never pass through the LLM |
| Loop speed | 20–30 s workspace cold start, preview "a few seconds after the last write" | **compiles in milliseconds, errors in the `write_files` response, preview at once** |
| Agents | Claude, ChatGPT, Cursor, Codex, Grok | any MCP client (OAuth 2.1 or an API key) |
| Extensibility | 70 skills, closed | **TypeScript modules against a public contract** — operators write their own |
| Limits | 1 project per plan ($10 / month) | many apps per workspace (limits are a plan setting, not the architecture) |
| Configuration | only through the agent / the editor | **MCP-first plus a full dashboard** for what does not belong in a chat: secrets, rules, domains, data, users |

## 2. The wider landscape

| Category | Players | Relevance |
|---|---|---|
| Agent cloud workspaces | **Macaly Cloud** | the same user flow, closed and SaaS-only (§1) |
| AI app builders | Replit Agent · Bolt.new · Lovable · GitHub Spark · v0 | build + host in their own UI with their own agent; closed SaaS, you pay for their model usage |
| MCP-native deploy | AppDeploy · Bonto · Netlify / Vercel MCP servers | "deploy from Claude → live URL"; the agent builds locally and uploads — no server-side compile loop, closed |
| Static / edge hosts | GitHub Pages · Netlify · Vercel · Cloudflare Pages / Workers | hosting without per-app data, auth or a dashboard for owners; Cloudflare Workers for Platforms is the primitive to watch for multi-tenant untrusted code |
| Self-hostable backends | PocketBase · Supabase · Appwrite | collections, auth and SDKs — but backends, not agent workspaces; PocketBase is the bar for simplicity |

## 3. What is actually different

The moat is the combination, not any single feature:

1. **Open source and self-hostable × an agent workspace with a backend.**
   Every agent-workspace or app-builder rival is closed SaaS; every
   self-hostable rival is a backend without the agent loop. drobek is on both
   axes: a company installs it on its own server and keeps its data.
2. **Safe by design.** No sandbox to escape, because nothing of the app runs on
   the server; backends are reviewed platform modules; every app is its own
   origin; secrets stay in the dashboard.
3. **Bring your own agent.** No builder UI and no token metering: the user
   pays their model provider, drobek limits apps, versions, mail and storage.
4. **The owner's side is a real product.** Confirmations for risky changes,
   data and form exports, end-user management, logs, custom domains, audit —
   the governance an internal-tools lead needs.

Not a moat, and we should not market it as one: "paste a prompt, get a live
URL" (table stakes now), the data/auth layer on its own (PocketBase and
Supabase are more mature), any single module.

## 4. Target and messaging

**Primary:** small businesses, teams and freelancers who build internal tools,
forms, calculators, dashboards over API data and small landing pages with
Claude or ChatGPT — and do not want to deal with hosting, databases, sign-in
or security.
**Secondary:** developers and companies who self-host drobek for themselves or
their clients (data residency, their own SSO in front, audit) and write their
own modules in TypeScript.

**One-liner:** *Connect your agent, it builds the app right in drobek —
instant preview, publish to your domain, sign-in, data and forms included,
no foreign code running on the server, open source and in the EU.*

**Angles:** (a) "Like Macaly, but open source and yours to run." (b) "Shadow
IT, sanctioned" — a governed home for the apps your team builds with AI.
(c) "Your walls or ours" — self-host for the security-conscious, drobek.app
for everyone else.

## 5. Risks

- **Macaly and the builders move down-market or open up** (a self-host tier,
  an EU region) and erase the sovereignty angle.
- **Incumbents bundle:** Netlify, Vercel or Cloudflare add a cheap
  agent-workspace tier with data and auth; they own distribution.
- **Backends grow a front-end:** PocketBase or Supabase add an MCP build loop
  and become a credible self-hostable alternative overnight.
- **"Good enough" substitution:** artifacts in the chat app plus a spreadsheet
  cover many small needs.
- **AGPL aversion** in some enterprises pushes them to SaaS; the arm's-length
  SaaS boundary ([`LICENSING.md`](./LICENSING.md)) keeps drobek.app on the
  public image, so that route stays open.
- **Abuse:** free app hosting attracts phishing; the report/takedown flow and
  the separate apps domain are launch requirements, not extras.

## 6. What this means for the product

1. The loop speed and the "never runs app code" story are the headline;
   keep compile errors in the write response and the preview instant.
2. Self-host must stay genuinely easy — one image, one compose file, one init
   command — it is the whole differentiator against Macaly.
3. Modules are the extension story: keep the contract small and public, and
   the built-in six boringly reliable.
4. The dashboard is the second leg, not a nicety: secrets, confirmations,
   domains and data are what the agent must not do.
5. Stay in the EU for drobek.app and say so plainly.
