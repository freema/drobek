# Oneshot prompt — build drobek from Linear (implement × verify split, chrome-devtools MCP)

> **What this is:** a self-contained briefing for the agent that one-shots drobek's implementation from the Linear backlog, stage by stage.
> **How to use:** run in the `drobek` repo (`/Users/tomasgrasl/projects/nodejs/drobek`; private repo `/Users/tomasgrasl/projects/nodejs/drobek-web`). Pass the stage as an argument — **default `M0`**. Execute as a **multi-agent Workflow** (or via the `dev-stage-orchestration` skill): implementer agents write code; a **separate TESTER agent running on a DIFFERENT MODEL** verifies every part in a real browser via the **`chrome-devtools` MCP**. No part is "done" until the tester passes it.
> **Status when written (2026-07-01):** spec ratified + reconciled (docs/ + Linear). No code exists yet — both repos are docs-only.

---

## 0. Roles — hard separation (this is the point of the setup)

| Role | Who | Model | May edit code? | Job |
|---|---|---|---|---|
| **Orchestrator** | the main agent reading this | session model | no (only orchestrates) | cut work into parts, spawn agents, run the fix loop, update Linear, commit |
| **Implementer** | subagent(s) per part | session model (inherit) | **yes** | implement the part + unit/Playwright specs, leave the local stack running |
| **Tester** | one subagent per verification | **a DIFFERENT model than the implementer** — set `model: 'opus'` (fallback `'sonnet'`) in the Workflow `agent()` call | **NO — read-only on source** | drive a real browser via chrome-devtools MCP against the running app; return a structured verdict |

Rules that must never be violated:
1. **The implementer never verifies its own work.** Different weights catch different failure modes — that is why the tester runs on another model.
2. **The tester never touches source files.** It may run read-only commands (`curl`, `docker compose ps`, `git diff --stat`) and browser tools; it reports, the implementer fixes.
3. A part iterates **implement → verify → fix** until the tester returns PASS, max **3 fix rounds** — then STOP and escalate to the operator with the tester's last findings verbatim.

## 1. Ground truth (read before writing code)

- **Linear** = the backlog: project **drobek** (team PhysioHub, key **PHY**), milestone order **M0 → M1a → M1b → M1c → M2 → M3**. Work strictly **WIP=1**, in milestone order. Entry ticket for M0 = **PHY-95**.
- **Repo docs** = the spec: `docs/ROADMAP.md` (§3 Phase 0 runbook P0-A…P0-F, §5 build units U2–U11, ratified D1–D5), `docs/ARCHITECTURE.md` (corrections block at top is authoritative), `docs/TECHNICAL_DESIGN.md` (schema + MCP/REST contracts), `docs/USER_FLOWS.md`.
- **Reference implementation** = `/Users/tomasgrasl/projects/nodejs/puls-mcp` (compose, `Dockerfile.prod`, `deploy.yml`, `tests-e2e/`, `apps/web/app/lib/health.ts`). Clone patterns from it, but respect the documented deltas (worker container, two drizzle journals, submodule lockfile script, OAuth AS = **build not port**).
- Where docs and Linear disagree, **the ratified-decisions block in ROADMAP.md wins**; flag the drift, don't silently pick.

## 2. Hard constraints (settled — do not relitigate)

1. **D1** apex `drobek.app` + `mcp.drobek.app`, reuse the kept cert, `noindex` during beta. Never create `beta.drobek.app`.
2. **D2** blobs = local-disk `BlobStore` (content-hash files) + drobek **signed-upload endpoint** that **stream-hashes and verifies sha256** (PHY-96/100). **No MinIO/S3, no `bytea`.** Persistent volume `drobek_blobs`.
3. **D3** `/healthz` returns real `{ok,db,redis}` with **503 on down**; `/api/version` returns `{sha}`; MCP health path is **`/health`**.
4. **D4** two drizzle journals (`__drizzle_migrations_core` / `__drizzle_migrations_web`), two migrate passes, one `drobek` DB; web config uses `tablesFilter`; P0-C proves a private table **with an FK to a core table**.
5. **D5** WIP=1 vertical slices; per-part Linear update.
6. Ports: drobek = **3041 (web) / 3042 (mcp)** — locally and on the VPS. 3011/3012 belong to puls; never collide.
7. Operator standards: **Taskfile** (`task up`, `task e2e` — never Makefile), **Hostinger SMTP** (no Resend/SES/SendGrid), pnpm monorepo, worker = 4th container `drobek-worker` (BullMQ: `maxRetriesPerRequest: null`, BullMQ `prefix` — not ioredis `keyPrefix`).
8. Schema day one: `blob_refs`, `kek_id`, `deleted_at` tombstones (PHY-101); super-admin = global env flag, **not** a memberships role.

## 3. Execution loop (per part; parts = P0-A…P0-F for M0, then U2…U9 for M1a)

1. **Implement** — spawn an implementer with: the part's ROADMAP section verbatim, the mapped PHY tickets, and the constraints above. It must also write the part's Playwright spec(s) (`@smoke`/`@local` tiers per ROADMAP §4) **in the same commit**.
2. **Static gates** — typecheck, lint, unit tests, `docker compose up` clean boot. Fail → back to 1 (counts as a fix round).
3. **Stack up** — ensure the dev stack is running and reachable on `http://localhost:3041` / `http://localhost:3042` before spawning the tester.
4. **Verify** — spawn the **tester** (different model) with the contract in §4 + the part's acceptance criteria from ROADMAP verbatim.
5. **Fix loop** — FAIL → feed the tester's findings verbatim to a fresh implementer; re-verify. Max 3 rounds, then escalate.
6. **Close** — on PASS: commit (conventional message, reference PHY ids), update the Linear ticket(s) (comment with what shipped + tester verdict summary; move state when a ticket is fully done), proceed to the next part. **Never start two parts in parallel.**

**Prod-touching parts (P0-D secrets, P0-E VPS/nginx/shared-postgres, P0-F first release): STOP and ask the operator before executing** — these are confirm-to-run by decree (shared box). After a prod deploy, the tester re-runs its checks against `https://drobek.app` + `https://mcp.drobek.app/health`.

## 4. Tester contract (chrome-devtools MCP) — embed this in every tester prompt

You are a **read-only verification agent**. You did not write this code; your job is to try to **fail** it, not to confirm it. You run on a different model than the author on purpose.

**Setup:** load the browser tools first via ToolSearch (one call):
`select:mcp__chrome-devtools__new_page,mcp__chrome-devtools__navigate_page,mcp__chrome-devtools__take_snapshot,mcp__chrome-devtools__take_screenshot,mcp__chrome-devtools__list_console_messages,mcp__chrome-devtools__list_network_requests,mcp__chrome-devtools__get_network_request,mcp__chrome-devtools__evaluate_script,mcp__chrome-devtools__click,mcp__chrome-devtools__fill,mcp__chrome-devtools__wait_for`

**Always check, for every part:**
- **Console is clean** — `list_console_messages`: zero errors; warnings listed in the report.
- **Health contract** — `/healthz` returns `{ok:true, db:'up', redis:'up'}` (and **503** when you stop a dep, if the part claims D3); `/api/version` returns a real sha; MCP `/health` (not `/healthz`) responds.
- **Network** — `list_network_requests`/`get_network_request`: no failed/4xx/5xx requests on the happy path; verify the headers the part claims (immutable cache on hashed assets, `no-store` on `/api/`, CSP + `nosniff` on served apps).
- **Evidence** — `take_screenshot` of each key state; quote exact response bodies/headers for every failed assertion.

**Then check the part's acceptance criteria** (provided verbatim from ROADMAP — e.g. P0-B: signed PUT+GET round-trip succeeds AND a tampered body is **rejected**; U7: team-only app gates an anonymous visitor). Attempt at least one **negative test** per part — the spec's reject/deny cases are first-class acceptance.

**Report back exactly this structure (your final message):**
```json
{
  "part": "P0-A",
  "verdict": "PASS" | "FAIL",
  "checks": [{"name": "...", "result": "pass|fail", "evidence": "exact body/header/console line"}],
  "console_errors": [], "network_failures": [],
  "screenshots": ["path or description"],
  "notes": "anything suspicious even if technically passing"
}
```
Do not edit any file. Do not "fix it quickly yourself". If the stack is not reachable, verdict = FAIL with evidence — do not start it yourself beyond `docker compose ps` to diagnose.

## 5. Workflow sketch (adapt, don't copy blindly)

```js
export const meta = { name: 'drobek-oneshot-m0', description: 'Build M0 from Linear with implement×verify split', phases: [{ title: 'Build' }] }
const PARTS = args?.parts ?? ['P0-A','P0-B','P0-C']   // P0-D/E/F gated on operator confirmation
for (const part of PARTS) {
  let feedback = '', pass = false
  for (let round = 0; round < 3 && !pass; round++) {
    await agent(`IMPLEMENT ${part} per docs/ROADMAP.md §3 + constraints… ${feedback}`, { label: `impl:${part}`, phase: 'Build' })
    const v = await agent(`VERIFY ${part}. <tester contract §4 + acceptance verbatim>`, { label: `verify:${part}`, model: 'opus', schema: VERDICT_SCHEMA })
    pass = v?.verdict === 'PASS'
    feedback = pass ? '' : `Previous round FAILED verification. Fix exactly these findings: ${JSON.stringify(v.checks.filter(c => c.result === 'fail'))}`
  }
  if (!pass) { log(`${part} failed after 3 rounds — stopping for operator`); return { stopped_at: part } }
  log(`${part} PASS`)
}
```
Subagents reach the session's `chrome-devtools` MCP via ToolSearch (works inside Workflow agents). The tester's `model` override is the "different model" requirement — keep it even if it costs more.

## 6. Stage DoD (M0 — from ROADMAP, all must be true)

Both repos build to GHCR with correct visibility · `docker compose up` runs both locally · the prod `drobek-saas-web` image executes core code (`/private`) · `drobek.app` + `mcp.drobek.app` serve over TLS · two drizzle journals applied to one DB · `@smoke` green local AND prod · **deploy-#2 rollback drill passed** · tester PASS on every part · Linear M0 tickets updated. Only then propose starting M1a (U2).

## 7. Guardrails

- **Never TRUNCATE / raw-SQL the shared postgres**; destructive test seeds only behind `ALLOW_DESTRUCTIVE=1` + hostname allowlist that can never resolve to the shared box.
- Secrets stay in `.env.production` (chmod 600) + GH secrets — never in git, never echoed into logs.
- Don't invent vendor/provider details — if the spec doesn't name it, ask.
- Every chrome-devtools verification that passes gets crystallized as a Playwright spec by the **implementer** in the same part (ROADMAP §4 rule) — the tester proves it once, CI keeps it proven.
- If a spec ambiguity blocks a part, stop and ask; do not improvise schema or contracts.
