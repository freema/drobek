# tests-eval — the agent eval (NSO-308)

A **manual** check that the agent skills work in practice. It is never run in CI, because it
costs model tokens and needs the local stack.

Three clean Claude Code sessions each build one reference app. Each session sees nothing but
the drobek MCP server: no files, no shell, no project settings, no other MCP servers. Then
the harness checks the result like a user would, in a real browser and against Mailpit.

| id | app | what the agent is asked | what the harness checks |
|---|---|---|---|
| a | contact-form | a contact page whose messages are e-mailed to the owner | a browser fills in and submits the form → 200 → Mailpit has the owner's `New "…" submission` mail with the run's stamp |
| b | team-list-admin | a shared list: two people may sign in, only admins add/remove | an anonymous visitor sees `<LoginGate>`; the owner signs in as `admin` and the member as `user`; the collection is 401 to anonymous visitors and 200 to the member; the member's POST is 403; the admin passes the create rule |
| c | proxy-call | show what `GET /echo/hello` on the workspace upstream `echo` returns | the member signs in; `/__drobek/v1/proxy/echo/echo/hello` → 200 and the upstream receives the injected bearer secret; in a browser the page calls the proxy (200) and shows the response |

Every app is also checked for these:

- the session finished;
- the agent created an app and did not publish it;
- the preview answers 200;
- the page throws no errors in the browser, and `get_logs` shows no runtime errors;
- the number of **non-existent API uses** is 0.

## Metrics (one row per app in `results/<date>-<stamp>.md`)

- **result**: PASS only when every check above passes.
- **write_files**: the number of `write_files` calls. Fewer means the skills gave working code
  on the first try.
- **tool calls (errors)**: every MCP call, and how many of them came back `isError`.
- **skills read**: the `skill_info({ name })` calls.
- **non-existent API**: this must be 0. It counts every use of an API that does not exist on
  the server, in every file content the agent wrote, including versions it later fixed.
  - "Exists" means it is in the server's own `/__drobek/sdk.d.ts`, parsed by `lib.mjs`.
  - It counts an unknown `drobek.<module>` or `drobek.<module>.<member>`.
  - It counts a made-up import from `drobek` or `drobek/<module>`.
  - It counts a request to an unknown `/__drobek/v1/<module>` route.
  - It counts a call to an MCP tool the server does not have.
- turns, cost and time come from Claude Code's final `result` event.

The raw transcripts (`results/*.jsonl`, stream-json) stay local and are git-ignored. The `.md`
table is what goes into the Linear task comment: the orchestrator posts it, and this script
never touches Linear.

## Prerequisites

1. **The local dev stack is running** (`task up`), with every built-in module (the compose
   default `DROBEK_MODULES`), Mailpit on :8025, and the `proxy-echo` helper container.
   **Nobody else should be running e2e against it at the same time.** The eval signs people in,
   and on the local stack every request shares one client-IP rate-limit bucket.
2. **Claude Code** (`claude`) is installed and signed in. The eval uses your account and your
   model quota.
3. **`pnpm install`** has been run. Playwright and the MCP SDK are loaded from `tests-e2e`,
   and so is a Chromium: `pnpm -C tests-e2e exec playwright install chromium`.

## Run

```sh
task eval -- --self-check        # the parsers on fixtures/ (no network, no Claude): exit 0
task eval -- --dry-run           # prerequisites + the exact claude command lines; creates nothing
task eval                        # all three apps (a,b,c); ~10–30 min, a few dollars
task eval -- --only b            # one app
task eval -- --mode plugin       # through the drobek plugin instead of a bare MCP config
```

A full run does these steps:

1. **It creates a synthetic owner.** The owner signs in to the dashboard as
   `eval-owner-<stamp>@example.com`, with the e-mail code from Mailpit.
2. **It mints a `read,write,publish` API key** for that user with
   `docker exec drobek node packages/oauth/dist/cli/api-key-create.js`. This is the
   `task api-key:create` CLI.
   - The key stays in memory: it is never written to a file.
   - The session's MCP config contains `"Authorization": "Bearer ${DROBEK_API_KEY}"`. Claude
     Code expands that from the child's environment.
3. **It registers the upstream `echo`** in the owner's workspace through the dashboard form. The
   base URL is `http://proxy-echo`, it allows `GET /echo`, and it uses a bearer secret that is
   generated for each run.
4. **For each app it runs one session:** `claude -p "<prompt>" --output-format stream-json
   --verbose --no-session-persistence --setting-sources project --tools "" --allowedTools
   mcp__drobek --strict-mcp-config --mcp-config <tmp>/mcp.json --disable-slash-commands
   --max-budget-usd 5`. It runs in an empty temp directory.
5. **It checks the app.** It confirms the app's pending module changes as the owner, through
   `POST /api/apps/:id/modules/:m/confirm`, just as the owner would with the agent's
   `confirm_url`. Then it runs the checks.
6. **It writes the results** to `results/<date>-<stamp>.md` and `.json`.

The exit code is 0 only when every app passes.

## Environment

| variable | default | meaning |
|---|---|---|
| `DROBEK_URL` | `http://localhost:3041` | dashboard + `/mcp` origin |
| `MAILPIT_URL` | `http://localhost:8025` | Mailpit REST API (sign-in codes, the owner's mail) |
| `DROBEK_API_KEY` + `EVAL_EMAIL` | — | use an existing key and its owner instead of a synthetic user (both are required; the owner still signs in to the dashboard through Mailpit) |
| `EVAL_CONTAINER` | `drobek` | the dev container the key is minted in |
| `EVAL_ECHO_BASE` | `http://proxy-echo` | the base URL of the `echo` upstream |
| `CLAUDE_BIN` | `claude` | the Claude Code binary |
| `EVAL_MODEL` | CLI default | `--model` for the sessions |
| `EVAL_MAX_BUDGET_USD` | `5` | `--max-budget-usd` per session |
| `EVAL_TIMEOUT_MS` | `1200000` | the session is killed after this long |
| `EVAL_TOOLS` | `""` | `--tools` (built-in tools; empty = none, so the agent can only use drobek) |
| `EVAL_BARE` | — | `1` adds `--bare`: no user CLAUDE.md, hooks or auto-memory. It then needs `ANTHROPIC_API_KEY`, because `--bare` skips keychain reads |
| `DROBEK_PLUGIN_DIR` | `../drobek-plugin/plugins/drobek` | `--mode plugin`: the plugin is copied and its `.mcp.json` pointed at `DROBEK_URL` with the key header |

`--keep` keeps the session's temp directory, so you can inspect it.

`--mode plugin` has limits:

- It omits `--strict-mcp-config` and `--disable-slash-commands`, because the plugin's MCP
  server and its skills must load. The user's other MCP servers can load too; their tools are
  not auto-approved.
- The tool prefix is `mcp__plugin_drobek_drobek__`.

## Files

- `run.mjs` is the harness: `--self-check`, `--dry-run`, and the full run.
- `lib.mjs` holds the pure parts. They parse the transcript, parse `sdk.d.ts`, detect
  non-existent APIs, and render the results. The `@drobek/skills-check` unit tests run them
  on the real generated SDK and on every skill example, so `task check` keeps them honest.
- `fixtures/` holds a synthetic stream-json transcript and a generated `sdk.d.ts` for
  `--self-check`.
- `results/` holds the run outputs: `.md` / `.json` for the task comment, and the git-ignored
  `.jsonl` transcripts.
