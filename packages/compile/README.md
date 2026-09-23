# @drobek/compile

In-process esbuild compiler for app sources. `write_files` calls it on every
write; the output is **served** to browsers. The server never executes it.

```ts
import { compile } from '@drobek/compile';

const r = await compile(new Map([
  ['drobek.json', '{"imports":{"react":"https://esm.sh/react@19","react-dom":"https://esm.sh/react-dom@19"}}'],
  ['src/main.tsx', "import { createRoot } from 'react-dom/client'; …"],
]));
// r.ok, r.outputs: Map<'main.js' | 'main.css' | 'assets/…', Buffer>,
// r.errors: [{ code, file, line, column, text }], r.warnings, r.inputs
```

## Pipeline

1. **Validate** (before esbuild): normalized paths (no `..`, no absolute),
   allowed extensions only, UTF-8 text, `COMPILE_MAX_FILES` (200),
   `COMPILE_MAX_FILE_BYTES` (512 KiB), `COMPILE_MAX_TOTAL_BYTES` (5 MiB) →
   `invalid_path` / `limit_exceeded`.
2. **Secret scan** of every text file (`sk-…`, `AKIA…`, `ghp_…`, PEM private
   keys, `apiKey = "…"`) → `secret_in_source`; the caller must not store the
   version. The value is never echoed.
3. **`drobek.json`**: `imports` (bare specifier → `https://` URL, kept
   external; `pkg/sub` maps to `imports.pkg + /sub`) and `entries` (extra entry
   points → `<basename>.js`). `src/main.{tsx,ts,jsx,js}` → `main.js` (+
   `main.css`). No entry at all = static app, nothing to bundle.
4. **esbuild** (`bundle`, `esm`, `es2022`, `jsx: automatic`, inline source
   map unless `sourcemap: false` for publish) with the `drobek-virtual-fs`
   plugin: relative and root-absolute imports resolve **only** in the
   in-memory file map (never the disk: `absWorkingDir` is an empty temp dir,
   `nodePaths: []`); `drobek` → `/__drobek/sdk.js`; `http(s)://` external (scheme-less `//host` is refused);
   anything else → `unresolved_import` with the exact `drobek.json` line to
   add. Import depth is capped at `COMPILE_MAX_IMPORT_DEPTH` (50).
5. **Runtime limits**: `COMPILE_CONCURRENCY` (4) builds at once, FIFO queue,
   waiting longer than `COMPILE_QUEUE_TIMEOUT_MS` (10 s) → `busy`;
   `COMPILE_TIMEOUT_MS` (10 s) → `timeout`. A timed-out build is cancelled on
   its own esbuild context, not via a global `esbuild.stop()`, so concurrent
   healthy builds survive.

Errors carry esbuild's own location: `line` is 1-based, `column` 0-based.
TypeScript types are **not** checked (esbuild strips them); type errors show
up as runtime errors in `get_logs`.

## Benchmark

The `react-ts` template (React via esm.sh, 3 modules + CSS) compiles in
**~3 ms warm** on an Apple-silicon laptop (`compiler.test.ts` asserts
< 100 ms and logs the measured time). The first call also spawns the esbuild
service (~50 ms once per process).
