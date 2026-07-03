# drobek skill

Teaches an agent (Claude Code, Cursor) to structure, deploy, and add data to a
static micro-app on drobek. It is intentionally thin: it teaches the WORKFLOW and
links the authoritative, always-current schemas (llms-full.txt + the MCP docs
resources) instead of duplicating them.

## Install (one command)

From a checkout of this repo:

```sh
cp -r skills/drobek ~/.claude/skills/drobek
```

That installs it as a user-level Claude Code skill. For a project-local install,
copy it to `.claude/skills/drobek` inside your project instead. Cursor and other
agents can read `SKILL.md` directly.

## Connect the MCP server

Point your agent's MCP client at the drobek MCP endpoint (default
`http://localhost:3042/mcp`, or your deployment's `PUBLIC_MCP_URL` + `/mcp`).
It is OAuth 2.1 (PKCE S256) — your MCP client drives discovery → registration →
consent → token automatically. See the "Connect" section of llms-full.txt.

## Maintenance rule (enforced)

**Any unit that changes the MCP tool surface or the SDK updates the drobek skill
(this folder) AND llms.txt / llms-full.txt in the SAME PR.**

- The tool-name half of that rule is enforced by a test, not by discipline: the
  drift-guard unit test in `@drobek/oauth`
  (`packages/oauth/src/resource/tool-docs-parity.test.ts`) asserts the set of
  tools the MCP server actually registers EQUALS `TOOL_NAMES` in
  `@drobek/agent-dx`. Add a tool without a doc (or remove a doc for a live tool)
  and CI fails.
- The docs (llms.txt / llms-full.txt / the MCP docs resources / this skill) all
  render from the same `@drobek/agent-dx` manifest, so updating the manifest
  updates every surface at once.

> Operator note: also add this same maintenance line to `docs/ROADMAP.md`
> section 5 (Definition of Done). It is intentionally NOT edited here.
