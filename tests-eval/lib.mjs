// @ts-check
/**
 * tests-eval (NSO-308) — the PURE parts of the agent eval, shared by run.mjs,
 * its --self-check and the @drobek/skills-check unit tests (which run them on
 * the real generated sdk.d.ts and on every skill example, so the parsers
 * cannot drift from the SDK format):
 *
 *  - parseTranscript: Claude Code `--output-format stream-json` lines → the
 *    tool calls (name, input, result, isError), write_files count, the files
 *    the agent wrote (last content per app + path), app ids / preview URLs;
 *  - parseSdkDts: /__drobek/sdk.d.ts → what exists (modules + Api members,
 *    `drobek/<m>` inline exports, root exports);
 *  - findApiMisuse: written files × that index → every use of an API that
 *    does not exist (unknown module / member / inline import / route);
 *  - relativeRefs / binaryWrites: the artifact-port checks (NSO-359) — the
 *    page keeps its relative paths, no binary travels through write_files;
 *  - renderResults: the Markdown table for the Linear comment.
 */

/**
 * @typedef {{ id: string, name: string, tool: string, input: any, isError: boolean, resultText: string }} ToolCall
 * @typedef {{
 *   toolCalls: ToolCall[],
 *   writeFilesCount: number,
 *   files: Map<string, Map<string, string>>,
 *   writes: { appId: string, path: string, content: string }[],
 *   appIds: string[],
 *   previewUrls: Map<string, string>,
 *   result: { ok: boolean, text: string, turns: number | null, costUsd: number | null, durationMs: number | null } | null,
 *   parseErrors: number,
 * }} Transcript
 * @typedef {{ modules: Map<string, Set<string>>, inline: Map<string, Set<string>>, root: Set<string> }} SdkIndex
 * @typedef {{ file: string, kind: 'module' | 'member' | 'import' | 'inline' | 'route' | 'tool', name: string }} Misuse
 */

/**
 * The drobek tool name of an MCP tool (`mcp__drobek__write_files`, `mcp__plugin_drobek_drobek__write_files` → `write_files`).
 * @param {string} name
 * @returns {string | null}
 */
export function drobekTool(name) {
  const m = /^mcp__(?:plugin_[a-z0-9_-]+_)?drobek__([a-z_]+)$/.exec(name);
  return m ? m[1] : null;
}

/** @param {unknown} content */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : ''))
      .join('\n');
  }
  return '';
}

/** First JSON object inside a tool result text (tools may wrap JSON in an untrusted envelope). @param {string} text */
export function jsonOf(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * @param {string} jsonl Claude Code stream-json output (one JSON event per line)
 * @returns {Transcript}
 */
export function parseTranscript(jsonl) {
  /** @type {Map<string, ToolCall>} */
  const byId = new Map();
  /** @type {ToolCall[]} */
  const toolCalls = [];
  /** @type {Transcript['result']} */
  let result = null;
  let parseErrors = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      parseErrors++;
      continue;
    }
    const content = ev?.message?.content;
    if (ev.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_use') continue;
        const call = { id: String(c.id), name: String(c.name), tool: drobekTool(String(c.name)) ?? String(c.name), input: c.input ?? {}, isError: false, resultText: '' };
        byId.set(call.id, call);
        toolCalls.push(call);
      }
    } else if (ev.type === 'user' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_result') continue;
        const call = byId.get(String(c.tool_use_id));
        if (!call) continue;
        call.isError = c.is_error === true;
        call.resultText = resultText(c.content);
      }
    } else if (ev.type === 'result') {
      result = {
        ok: ev.subtype === 'success' && ev.is_error !== true,
        text: typeof ev.result === 'string' ? ev.result : '',
        turns: typeof ev.num_turns === 'number' ? ev.num_turns : null,
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
        durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
      };
    }
  }

  /** @type {Map<string, Map<string, string>>} */
  const files = new Map();
  /** @type {string[]} */
  const appIds = [];
  /** @type {Map<string, string>} */
  const previewUrls = new Map();
  /** @type {Transcript['writes']} */
  const writes = [];
  let writeFilesCount = 0;
  for (const call of toolCalls) {
    const body = call.resultText ? jsonOf(call.resultText) : null;
    if (call.tool === 'create_app' && body && typeof body.app_id === 'string') {
      if (!appIds.includes(body.app_id)) appIds.push(body.app_id);
      if (typeof body.preview_url === 'string') previewUrls.set(body.app_id, body.preview_url);
    }
    if (call.tool !== 'write_files') continue;
    writeFilesCount++;
    const appId = String(call.input?.app_id ?? '');
    if (appId && !appIds.includes(appId)) appIds.push(appId);
    if (body && typeof body.preview_url === 'string' && appId) previewUrls.set(appId, body.preview_url);
    if (call.isError) continue; // a refused write stored nothing
    const map = files.get(appId) ?? new Map();
    for (const f of Array.isArray(call.input?.files) ? call.input.files : []) {
      if (typeof f?.path !== 'string') continue;
      if (f.delete === true) map.delete(f.path);
      else if (typeof f.content === 'string') {
        map.set(f.path, f.content);
        writes.push({ appId, path: f.path, content: f.content });
      }
    }
    files.set(appId, map);
  }
  return { toolCalls, writeFilesCount, files, writes, appIds, previewUrls, result, parseErrors };
}

/**
 * The API that exists on the server, from its `/__drobek/sdk.d.ts`.
 * @param {string} dts
 * @returns {SdkIndex}
 */
export function parseSdkDts(dts) {
  const lines = dts.replace(/\/\*[\s\S]*?\*\//g, '').split('\n');
  /** @type {Map<string, Set<string>>} */
  const modules = new Map();
  /** @type {Map<string, Set<string>>} */
  const inline = new Map();
  const root = new Set(['drobek', 'default']);
  for (let i = 0; i < lines.length; i++) {
    const ns = /^export declare namespace ([a-z][a-z0-9]*) \{\s*$/.exec(lines[i]);
    if (ns) {
      const members = new Set();
      let inApi = false;
      let depth = 0;
      for (i = i + 1; i < lines.length && lines[i] !== '}'; i++) {
        const line = lines[i];
        if (!inApi && /^\s*export interface Api\b.*\{\s*$/.test(line)) {
          inApi = true;
          depth = 1;
          continue;
        }
        if (!inApi) continue;
        const code = line.replace(/\/\/.*$/, '');
        if (depth === 1) {
          const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?]?\s*[<(:]/.exec(code);
          if (m) members.add(m[1]);
        }
        for (const ch of code) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        if (depth <= 0) inApi = false;
      }
      modules.set(ns[1], members);
      continue;
    }
    const header = /^\/\/ ── import \{ … \} from 'drobek\/([a-z][a-z0-9]*)'/.exec(lines[i]);
    if (header) {
      const names = new Set();
      for (i = i + 1; i < lines.length && lines[i].startsWith('//'); i++) {
        const m = /^\/\/\s*export (?:declare )?(?:function|interface|type|const|class) ([A-Za-z_$][\w$]*)/.exec(lines[i]);
        if (m) names.add(m[1]);
      }
      inline.set(header[1], names);
      continue;
    }
    const top = /^export (?:declare )?(?:class|interface|const|type|function) ([A-Za-z_$][\w$]*)/.exec(lines[i]);
    if (top) root.add(top[1]);
  }
  return { modules, inline, root };
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|html)$/;
const NOT_A_MODULE = new Set(['json', 'app']);

/**
 * Every use of a drobek API that does not exist on the server (each distinct
 * name once). Pass EVERY content the agent wrote (`Transcript.writes`), not
 * only the final files: a made-up call that was fixed later still counts.
 * @param {Iterable<[string, string]>} files [path, content] pairs
 * @param {SdkIndex} sdk
 * @returns {Misuse[]}
 */
export function findApiMisuse(files, sdk) {
  /** @type {Misuse[]} */
  const out = [];
  /** @param {Misuse} m */
  const add = (m) => {
    if (!out.some((o) => o.kind === m.kind && o.name === m.name)) out.push(m);
  };
  for (const [file, raw] of files) {
    if (!CODE_FILE.test(file)) continue;
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const m of text.matchAll(/(?<![\w$.@/-])drobek\s*\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
      const [, mod, member] = m;
      if (NOT_A_MODULE.has(mod)) continue; // drobek.json, drobek.app in text and URLs
      if (!/^\s*import\b/.test(text.slice(text.lastIndexOf('\n', m.index) + 1, m.index))) {
        const members = sdk.modules.get(mod);
        if (!members) add({ file, kind: 'module', name: `drobek.${mod}` });
        else if (member && !members.has(member)) add({ file, kind: 'member', name: `drobek.${mod}.${member}` });
      }
    }
    for (const m of text.matchAll(/import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]drobek(?:\/([a-z0-9-]+))?['"]/g)) {
      const [, def, named, sub] = m;
      const names = (named ?? '')
        .split(',')
        .map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      if (sub === undefined) {
        for (const n of names) if (!sdk.root.has(n)) add({ file, kind: 'import', name: `${n} from 'drobek'` });
        continue;
      }
      const exported = sdk.inline.get(sub);
      if (!exported) {
        add({ file, kind: 'inline', name: `drobek/${sub}` });
        continue;
      }
      if (def) add({ file, kind: 'inline', name: `default from 'drobek/${sub}'` });
      for (const n of names) if (!exported.has(n)) add({ file, kind: 'inline', name: `${n} from 'drobek/${sub}'` });
    }
    for (const m of text.matchAll(/\/__drobek\/v1\/([A-Za-z0-9_-]+)/g)) {
      if (m[1] !== '_beacon' && !sdk.modules.has(m[1])) add({ file, kind: 'route', name: `/__drobek/v1/${m[1]}` });
    }
  }
  return out;
}

/**
 * MCP tool calls to a drobek tool the server does not have.
 * @param {ToolCall[]} calls
 * @param {string[]} knownTools
 * @returns {Misuse[]}
 */
export function unknownToolCalls(calls, knownTools) {
  return calls
    .filter((c) => drobekTool(c.name) !== null && !knownTools.includes(/** @type {string} */ (drobekTool(c.name))))
    .map((c) => ({ file: '(mcp)', kind: /** @type {const} */ ('tool'), name: c.tool }));
}

/**
 * The form name the app submits to (`<Form name="…">` or `drobek.forms.submit('…')`), or null.
 * @param {Map<string, string>} files
 */
export function formNameOf(files) {
  for (const text of files.values()) {
    const m =
      /<Form\b[^>]*?\bname=["']([a-z0-9][a-z0-9_-]{0,39})["']/.exec(text) ??
      /drobek\.forms\.(?:submit|prepare)\(\s*['"]([a-z0-9][a-z0-9_-]{0,39})['"]/.exec(text);
    if (m) return m[1];
  }
  return null;
}

/**
 * NSO-359 (port an artifact): the relative references of an HTML page —
 * `src`, `href` and `poster` values that are not a URL, a `data:` URI, a
 * fragment or root-absolute — in document order, deduplicated. The port keeps
 * every one of them unchanged.
 * @param {string} html
 * @returns {string[]}
 */
export function relativeRefs(html) {
  const out = new Set();
  for (const m of html.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = m[1].trim();
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(ref)) continue;
    out.add(ref);
  }
  return [...out];
}

/** Text extensions write_files takes; anything else in a ported folder is an asset (create_asset_upload). */
export const TEXT_FILE_EXTS = ['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.md', '.jsx', '.tsx', '.ts', '.webmanifest'];

/**
 * Every write that carried a binary through the model: a media path sent to
 * write_files, or a text file with an inlined base64 blob of more than 1 KiB.
 * @param {{ path: string, content: string }[]} writes
 * @returns {string[]} the offending paths
 */
export function binaryWrites(writes) {
  /** @type {string[]} */
  const out = [];
  for (const w of writes) {
    const ext = w.path.slice(w.path.lastIndexOf('.')).toLowerCase();
    if (!TEXT_FILE_EXTS.includes(ext) || /;base64,[A-Za-z0-9+/=]{1024,}/.test(w.content)) out.push(w.path);
  }
  return out;
}

/**
 * @typedef {{
 *   app: string, pass: boolean, writeFiles: number, toolCalls: number, toolErrors: number,
 *   skills: string[], misuse: string[], turns: number | null, costUsd: number | null,
 *   durationMs: number | null, checks: { name: string, ok: boolean, detail?: string }[]
 * }} EvalRow
 */

/** @param {string} s */
const cell = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * The Markdown results (for the task comment).
 * @param {{ date: string, target: string, mode: string, model: string, rows: EvalRow[] }} run
 */
export function renderResults(run) {
  const out = [
    `# drobek agent eval — ${run.date}`,
    '',
    `Target \`${run.target}\`, mode \`${run.mode}\`, model \`${run.model}\`. Each app = one clean \`claude -p\` session with only the drobek MCP (the artifact port also gets file reads and curl).`,
    '',
    '| app | result | write_files | tool calls (errors) | skills read | non-existent API | turns | cost | time |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of run.rows) {
    out.push(
      `| ${cell(r.app)} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.writeFiles} | ${r.toolCalls} (${r.toolErrors}) | ${cell(r.skills.join(', ') || '—')} | ${r.misuse.length === 0 ? '0' : cell(`${r.misuse.length}: ${r.misuse.join(', ')}`)} | ${r.turns ?? '—'} | ${r.costUsd === null ? '—' : `$${r.costUsd.toFixed(2)}`} | ${r.durationMs === null ? '—' : `${Math.round(r.durationMs / 1000)} s`} |`
    );
  }
  out.push('', '## Checks', '');
  for (const r of run.rows) {
    out.push(`### ${r.app}`, '');
    for (const c of r.checks) out.push(`- ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${cell(c.detail)}` : ''}`);
    out.push('');
  }
  const misuse = run.rows.reduce((n, r) => n + r.misuse.length, 0);
  out.push(`Non-existent API uses in total: **${misuse}** (must be 0).`, '');
  return out.join('\n');
}
