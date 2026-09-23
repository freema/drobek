---
name: drobek
description: Work in a drobek cloud workspace from your agent. Use when the user wants to inspect their drobek apps, add or query a JSON-schema-backed data collection (todos, guestbook, notes, etc.), or read the runtime errors real users hit, over the drobek MCP server.
---

# Work in drobek

drobek is an open-source cloud workspace for agent-built web apps. You (the
agent) connect to the drobek MCP server and work directly in the user's drobek
workspace. Every change to an app is an immutable **version**; the owner
publishes a version from the dashboard (publishing an older one is the
rollback). Apps that store data use JSON-schema-backed collections.

Connect the MCP server first (OAuth 2.1, PKCE). The AUTHORITATIVE,
always-current tool schemas live in llms-full.txt and the MCP docs resource —
link to them, do not hand-copy schemas into app code.

## Your workspace

1. Call `whoami` to learn your `workspace` slug and role.
2. Call `list_apps` to see the apps in it (slug, status, visibility).

App slugs are global host labels: 3–40 characters of `a–z`, `0–9` and single
dashes.

## Define your data schema first

If the app stores data, define the collection BEFORE writing code against it, so
the schema is the contract:

1. Call `collection_define({ workspace, slug, name, jsonSchema, accessMode })`.
   - `jsonSchema` is a real JSON Schema; every write is validated against it.
   - `accessMode` decides anonymous access (see the next section).
2. Only then write the app code (and any seed `record_create` calls) against
   those exact field names.

Re-calling `collection_define` for the same (app, collection) updates it — it is
idempotent, so you can evolve the schema.

## Use the data tools

Read and write the collections with `record_create`, `record_read`,
`record_update`, `record_delete` and `record_query`.

Pick the access mode by who needs to write from the browser:

- `public-write` — anyone can read AND write (schema still validated). Good for a
  public guestbook/todo demo.
- `public-read` — anyone reads; only an editor+ member writes.
- `locked` — no anonymous access at all (members only).
- `owner-only` — per-end-user data; record ops currently answer
  `not_implemented`, so pick one of the modes above.

Every write is schema-validated, write-rate-limited, and storage-quota-capped
regardless of mode.

## Check for errors

- Tool failures come back with `isError: true` and a JSON body
  `{ error: <code>, message, details? }`. Read the `code` and act on it (e.g.
  `validation_failed` → fix the doc against the schema; `too_many_docs` → the
  app hit its document cap).
- The full code → meaning → fix table is the Error catalogue in llms-full.txt.

## Close the loop: read runtime errors

drobek captures runtime problems from real users of an app so you can
self-correct without a human relaying the console:

- `app_errors({ workspace, slug, since? })` — recent client-side errors
  (window.onerror + unhandledrejection), DEDUPED by message + stack head with
  counts, first/last-seen, the last URL, and a `file:line` hint.
- `app_logs({ workspace, slug, since? })` — serving signals (request volume,
  5xx count, the top 404-by-path) and the app's recent versions with their
  compile status and which one is published.

Fix what they report (a 404 on `/app.js` → a wrong asset path; a `TypeError`
with a `file:line` hint → patch that line) and re-check until both are clean.

## Authoritative schemas

Do NOT duplicate the full tool schemas here — they can change. Read the
authoritative, always-current contract:

- llms.txt (index) and **llms-full.txt** (every tool with its input schema + an
  example, data access modes, limits, and the error catalogue) at your drobek
  origin, e.g. `http://localhost:3041/llms-full.txt`.
- Or, once connected to MCP, read the `drobek://docs/llms-full` resource and the
  `drobek://docs/tools` resource — no web access needed.
- The guided MCP prompt `add-data-to-app` walks the exact call sequence.

See README.md in this skill for the one-command install and the maintenance rule.
