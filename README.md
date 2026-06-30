# drobek

> Open-source hosting for **vibecoded micro-projects**. Drop a small HTML/static app and get a live URL in one step — MCP-native.

**Status:** 🌱 Early — we're shaping the concept. Architecture and APIs will change.

---

## The problem

Inside companies, people constantly produce **tiny one-off projects**: an internal dashboard, a landing page, a calculator, a demo for a client, a "can you make me a quick page that shows X". More and more of these are **vibecoded** — generated in minutes with an AI agent.

These projects have nowhere to live:

- **localhost** → disappears when you close the laptop
- **a ZIP in Slack** → nobody runs it
- **"real" hosting** (Vercel/Netlify/S3) → overkill for one HTML file: needs an account, a git repo, a build step, config
- **internal infra** → a ticket to IT, wait a week

So great little things never reach the people who'd use them.

## What drobek does

drobek is **"paste & it's live."** Hand it a folder or an HTML file → get a URL. No build, no config for static projects.

The headline channel is **MCP-native deployment**: the same AI agent that built the project deploys it. *"Deploy this to drobek"* → one tool call → live URL. Zero context switch, no leaving the chat.

## Deploy channels (planned)

- **MCP** — the agent that wrote it ships it (primary)
- **CLI** — `drobek deploy ./my-app`
- **Web drag & drop** — for non-devs
- **API / git push** — for everything else

*(Exact set is still open — see Open questions.)*

## Open core

drobek is an **open-core** project:

| Repo | Visibility | What |
| --- | --- | --- |
| [`drobek`](https://github.com/freema/drobek) (this repo) | public · AGPL-3.0 | The engine: project model, deploy pipeline, runtime that serves projects, MCP server. **Self-hostable** — run your own drobek. |
| `drobek-web` | private | Managed SaaS control plane built on top of the core: dashboard, auth, teams, billing, custom domains, quotas. |

## Core concepts

- **Project** — a deployed unit (static bundle or small app); has a name, an owner, a URL.
- **Deploy** — an immutable version of a project (rollback-able).
- **Channel** — how a deploy arrives (MCP / CLI / web / API).
- **Hosting** — drobek serves the project on a subdomain (and, later, custom domains) with TLS.

## Open questions (being decided)

- **Static only, or running backends too?** (static is ~10× simpler; backends need isolation)
- Runtime & serving model (object storage + router? containers per project?)
- Isolation & security for untrusted vibecoded code
- Auth & multi-tenancy
- How a bundle travels over MCP (inline? presigned upload?)
- Subdomain + custom-domain + wildcard TLS model
- Quotas, limits, lifecycle (do stale projects expire?)

## License

[AGPL-3.0](./LICENSE). The managed SaaS (`drobek-web`) stays private.
