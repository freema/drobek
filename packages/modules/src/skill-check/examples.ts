/**
 * "The code in the examples does not rot" (NSO-308, a library since NSO-349):
 * every fenced block of a skill is checked against drobek's compiler and the
 * SDK types of the given modules.
 *
 * By the block's info string:
 *
 *  - ```tsx / ```ts / ```jsx / ```js — an app file. The first line may name it
 *    (`// src/main.tsx`, default `src/main.<lang>`). It is compiled with
 *    @drobek/compile exactly like write_files does (the skill's import map,
 *    the server's sdk.js URL, the modules' inline sources `drobek/<m>`, the
 *    secret scan) AND typechecked with the TypeScript compiler against the
 *    generated `sdk.d.ts` + the inline declarations + @types/react — esbuild
 *    strips types, so only tsc sees a renamed SDK method.
 *  - ```ts api — a declaration excerpt of the SDK. Its first line names the
 *    target (`// drobek.auth` = the `auth` namespace of sdk.d.ts, `// drobek/auth`
 *    = the inline import). Every exported declaration must exist in the target
 *    and be MUTUALLY assignable to it: the documented API is the real one.
 *  - ```json drobek.json — the import map for the skill's following app files
 *    (default: the react-ts template's). Must pass readAppConfig.
 *  - ```json with `module` + `config` — a configure_module payload: the config
 *    merged over the module's defaults must pass the module's schema.
 *    Any other ```json must parse.
 *  - ```html — compiled as a static page; `<script src>` may only load from the
 *    app itself or https://esm.sh (the apps CSP), and esm.sh only as a module.
 *  - ```css — compiled (esbuild parses it).
 *  - ```sh / ```text — prose, not checked. A block without a language fails.
 */
import { dirname, join, posix, resolve } from 'node:path';
import type TS from 'typescript';
import { TEMPLATE_IMPORTS } from '@drobek/agent-dx';
import { Compiler, readAppConfig, type CompileMessage } from '@drobek/compile';
import type { AnyModule } from '../contract.js';
import { mergePatch } from '../merge-patch.js';
import { buildSdk, type SdkBundle } from '../sdk-build.js';
import { codeBlocks, type CodeBlock } from './markdown.js';
import type { SkillIssue, SkillSource } from './source.js';

/**
 * The TypeScript compiler, loaded on the first check: `typescript` is an
 * (optional) peer of the published package, and nothing else in
 * @drobek/modules needs it.
 */
let ts: typeof TS;
async function loadTypescript(): Promise<void> {
  ts ??= ((await import('typescript')) as unknown as { default: typeof TS }).default;
}

const CODE_LANGS = ['ts', 'tsx', 'js', 'jsx'] as const;
const CHECKED_LANGS = [...CODE_LANGS, 'json', 'html', 'css'] as const;
const PROSE_LANGS = ['sh', 'text'] as const;

/**
 * Virtual files live "inside" `root` (never written to disk) so the examples'
 * bare imports resolve that directory's node_modules (e.g. @types/react).
 */
let VROOT = '';

export interface ExamplesOptions {
  /** The SDK bundle of `modules` (built when omitted). */
  sdk?: SdkBundle;
  /** The directory whose node_modules resolve the examples' bare imports (default: the working directory). */
  root?: string;
}

export interface ExamplesReport {
  problems: SkillIssue[];
  counts: { blocks: number; compiled: number; typechecked: number; apiChecked: number; configChecked: number };
}

interface CodeUnit {
  skill: SkillSource;
  block: CodeBlock;
  /** The app path of the block's file. */
  path: string;
  files: Map<string, string>;
  /** Virtual path of the typechecked copy. */
  vpath: string;
}

interface ApiUnit {
  skill: SkillSource;
  block: CodeBlock;
  docPath: string;
  checkPath: string;
  check: string;
  /** check.ts line (0-based) → documented name. */
  names: Map<number, string>;
}

const PATH_COMMENT_RE = /^\/\/\s*(src\/[\w./-]+\.(?:tsx|ts|jsx|js))\s*$/;

function problem(skill: SkillSource, block: CodeBlock, message: string, lineInBlock = 0): SkillIssue {
  return { skill: skill.name, file: skill.file, block: block.index, line: block.line + lineInBlock, message };
}

/** Where the block's text starts inside SKILL.md relative to skill_info content (frontmatter offset). */
function frontmatterOffset(skill: SkillSource): number {
  const idx = skill.fileText.indexOf(skill.content.trim().split('\n')[0]);
  return idx <= 0 ? 0 : skill.fileText.slice(0, idx).split('\n').length - 1;
}

function compileMessage(m: CompileMessage): string {
  const where = m.file ? `${m.file}${m.line ? `:${m.line}:${m.column ?? 0}` : ''} ` : '';
  return `compile ${m.code}: ${where}${m.text}`;
}

function relativeCssImports(code: string, from: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(?:from\s+|import\s+)['"](\.{1,2}\/[^'"]+\.css)['"]/g)) {
    out.push(posix.normalize(posix.join(posix.dirname(from), m[1])));
  }
  return out;
}

function bareImports(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/(?:from\s+|import\s+|import\()\s*['"]([^'"./][^'"]*)['"]/g)) out.add(m[1]);
  return [...out];
}

function hasModuleSyntax(code: string): boolean {
  return /^\s*(import|export)\s/m.test(code);
}

/** The target of an api block: `// drobek.auth` or `// drobek/auth`. */
function apiTarget(code: string): { kind: 'ns'; name: string } | { kind: 'inline'; name: string } | null {
  const first = code.split('\n')[0].trim();
  const ns = /^\/\/\s*drobek\.([a-z][a-z0-9]*)\s*$/.exec(first);
  if (ns) return { kind: 'ns', name: ns[1] };
  const inline = /^\/\/\s*drobek\/([a-z][a-z0-9]*)\s*$/.exec(first);
  if (inline) return { kind: 'inline', name: inline[1] };
  return null;
}

interface Exported {
  name: string;
  typeParams: number;
  value: boolean;
}

function exportedDeclarations(code: string): Exported[] {
  const sf = ts.createSourceFile('doc.d.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: Exported[] = [];
  const isExported = (n: TS.Node) =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of sf.statements) {
    if (!isExported(st)) continue;
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
      out.push({ name: st.name.text, typeParams: st.typeParameters?.length ?? 0, value: false });
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
      if (!out.some((e) => e.name === st.name!.text)) out.push({ name: st.name.text, typeParams: 0, value: true });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, typeParams: 0, value: true });
    }
  }
  return out;
}

function apiCheckSource(target: { kind: 'ns' | 'inline'; name: string }, exported: Exported[]): { check: string; names: Map<number, string> } {
  const lines = [
    "import type * as Doc from './doc';",
    target.kind === 'ns' ? `import type { ${target.name} as Real } from 'drobek';` : `import type * as Real from 'drobek/${target.name}';`,
    'type __Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;',
    'type __T = { title: string; done: boolean };',
  ];
  const names = new Map<number, string>();
  for (const e of exported) {
    const args = e.typeParams ? `<${Array(e.typeParams).fill('__T').join(', ')}>` : '';
    const doc = e.value ? `typeof Doc.${e.name}` : `Doc.${e.name}${args}`;
    const real = e.value ? `typeof Real.${e.name}` : `Real.${e.name}${args}`;
    names.set(lines.length, e.name);
    lines.push(`export const __${e.name}: __Eq<${doc}, ${real}> = true;`);
  }
  return { check: lines.join('\n') + '\n', names };
}

function checkHtml(skill: SkillSource, block: CodeBlock, problems: SkillIssue[]): void {
  for (const m of block.code.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!src) continue;
    const external = /^(?:https?:)?\/\//i.test(src);
    if (external && !src.startsWith('https://esm.sh/')) {
      problems.push(problem(skill, block, `<script src="${src}"> is blocked by the apps CSP (scripts only from the app itself and https://esm.sh)`));
    }
    if (src.startsWith('https://esm.sh/') && !/\btype\s*=\s*["']module["']/i.test(attrs)) {
      problems.push(problem(skill, block, `<script src="${src}"> needs type="module" (esm.sh serves ES modules)`));
    }
  }
}

function checkConfigure(skill: SkillSource, block: CodeBlock, value: Record<string, unknown>, modules: AnyModule[], problems: SkillIssue[]): boolean {
  const name = value.module;
  const m = modules.find((x) => x.name === name);
  if (!m) {
    problems.push(problem(skill, block, `configure_module payload names an unknown module ${JSON.stringify(name)}`));
    return true;
  }
  if (typeof value.app_id !== 'string') problems.push(problem(skill, block, 'configure_module payload without an "app_id" string'));
  const merged = mergePatch(m.configDefaults, value.config);
  const parsed = (m.configSchema as { safeParse(v: unknown): { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } }).safeParse(merged);
  if (!parsed.success) {
    const issues = (parsed.error?.issues ?? []).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
    problems.push(problem(skill, block, `configure_module config fails the "${m.name}" schema: ${issues}`));
  }
  return true;
}

/** A TypeScript host over real files (cached) + the virtual unit files. */
const sourceFileCache = new Map<string, TS.SourceFile>();
function virtualHost(options: TS.CompilerOptions, vfiles: Map<string, string>): TS.CompilerHost {
  const base = ts.createCompilerHost(options, true);
  const vdirs = new Set<string>();
  for (const f of vfiles.keys()) {
    for (let d = dirname(f); d.startsWith(VROOT); d = dirname(d)) vdirs.add(d);
  }
  return {
    ...base,
    fileExists: (f) => vfiles.has(f) || base.fileExists(f),
    readFile: (f) => vfiles.get(f) ?? base.readFile(f),
    directoryExists: (d) => vdirs.has(d) || (base.directoryExists ? base.directoryExists(d) : true),
    realpath: (p) => (vfiles.has(p) || vdirs.has(p) ? p : base.realpath ? base.realpath(p) : p),
    getSourceFile(f, lang, onError) {
      const v = vfiles.get(f);
      if (v !== undefined) return ts.createSourceFile(f, v, lang, true);
      let sf = sourceFileCache.get(f);
      if (!sf) {
        sf = base.getSourceFile(f, lang, onError);
        if (sf) sourceFileCache.set(f, sf);
      }
      return sf;
    },
  };
}

function tsOptions(): TS.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    strict: true,
    noEmit: true,
    allowJs: true,
    checkJs: true,
    skipLibCheck: false,
    isolatedModules: true,
    baseUrl: VROOT,
    paths: { drobek: ['types/drobek.d.ts'], 'drobek/*': ['types/inline/*.d.ts'] },
  };
}

/**
 * Compile and typecheck every code block of `skills` against the SDK of
 * `modules` (the server's sdk.d.ts + the inline declarations).
 */
export async function checkExamples(skills: SkillSource[], modules: AnyModule[], opts: ExamplesOptions = {}): Promise<ExamplesReport> {
  await loadTypescript();
  VROOT = join(resolve(opts.root ?? process.cwd()), '.drobek-skill-check');
  const bundle = opts.sdk ?? (await buildSdk(modules));
  const problems: SkillIssue[] = [];
  const counts = { blocks: 0, compiled: 0, typechecked: 0, apiChecked: 0, configChecked: 0 };
  const codeUnits: CodeUnit[] = [];
  const apiUnits: ApiUnit[] = [];
  const staticUnits: { skill: SkillSource; block: CodeBlock; files: Map<string, string> }[] = [];

  for (const skill of skills) {
    const offset = frontmatterOffset(skill);
    let imports: Record<string, string> = { ...TEMPLATE_IMPORTS };
    for (const raw of codeBlocks(skill.content)) {
      const block = { ...raw, line: raw.line + offset };
      counts.blocks++;
      const lang = block.lang;
      if (!lang) {
        problems.push(problem(skill, block, 'code block without a language (use tsx/ts/jsx/js/json/html/css, or text/sh for prose)'));
        continue;
      }
      if ((PROSE_LANGS as readonly string[]).includes(lang)) continue;
      if (!(CHECKED_LANGS as readonly string[]).includes(lang)) {
        problems.push(problem(skill, block, `unknown code block language "${lang}" (allowed: ${[...CHECKED_LANGS, ...PROSE_LANGS].join(', ')})`));
        continue;
      }

      if (lang === 'json') {
        let value: unknown;
        try {
          value = JSON.parse(block.code);
        } catch (err) {
          problems.push(problem(skill, block, `invalid JSON: ${(err as Error).message}`));
          continue;
        }
        if (block.meta === 'drobek.json') {
          const { config, errors } = readAppConfig(new Map([['drobek.json', block.code]]));
          for (const e of errors) problems.push(problem(skill, block, `drobek.json: ${e.text}`));
          imports = config.imports;
          continue;
        }
        if (value && typeof value === 'object' && !Array.isArray(value) && 'module' in value && 'config' in value) {
          if (checkConfigure(skill, block, value as Record<string, unknown>, modules, problems)) counts.configChecked++;
        }
        continue;
      }

      if (lang === 'html') {
        checkHtml(skill, block, problems);
        staticUnits.push({ skill, block, files: new Map([['index.html', block.code]]) });
        continue;
      }

      if (lang === 'css') {
        staticUnits.push({
          skill,
          block,
          files: new Map([
            ['src/main.ts', "import './styles.css';\n"],
            ['src/styles.css', block.code],
            ['drobek.json', JSON.stringify({ imports })],
          ]),
        });
        continue;
      }

      // ts / tsx / js / jsx
      const id = `${skill.name}-${block.index}`;
      if (block.meta === 'api') {
        const target = apiTarget(block.code);
        if (!target) {
          problems.push(problem(skill, block, 'an api block must start with `// drobek.<module>` or `// drobek/<module>`'));
          continue;
        }
        const exported = exportedDeclarations(block.code);
        if (exported.length === 0) {
          problems.push(problem(skill, block, 'an api block must export the declarations it documents'));
          continue;
        }
        if (target.kind === 'ns' && !exported.some((e) => e.name === 'Api')) {
          problems.push(problem(skill, block, `an api block for drobek.${target.name} must export its \`interface Api\``));
        }
        const dir = join(VROOT, 'api', id);
        const { check, names } = apiCheckSource(target, exported);
        apiUnits.push({ skill, block, docPath: join(dir, 'doc.d.ts'), checkPath: join(dir, 'check.ts'), check, names });
        continue;
      }
      const first = block.code.split('\n')[0];
      const path = PATH_COMMENT_RE.exec(first)?.[1] ?? `src/main.${lang}`;
      const files = new Map<string, string>([[path, block.code]]);
      for (const css of relativeCssImports(block.code, path)) if (!files.has(css)) files.set(css, '');
      const isMain = /^src\/main\.(tsx|ts|jsx|js)$/.test(path);
      files.set('drobek.json', JSON.stringify({ imports, ...(isMain ? {} : { entries: [path] }) }));
      codeUnits.push({ skill, block, path, files, vpath: join(VROOT, 'u', id, path) });
    }
  }

  // 1. compile — exactly the write_files compiler with this server's SDK.
  const compiler = new Compiler();
  const compileOpts = { sdkUrl: bundle.url, sdkSources: bundle.inline, beaconUrl: bundle.beacon.url };
  for (const u of [...codeUnits, ...staticUnits]) {
    const r = await compiler.compile(u.files, compileOpts);
    counts.compiled++;
    for (const e of r.errors) {
      const inBlock = 'path' in u && e.file === u.path && e.line ? e.line : 0;
      problems.push(problem(u.skill, u.block, compileMessage(e), inBlock));
    }
  }

  // 2. typecheck — ONE program: every app file + every api check, against sdk.d.ts.
  const vfiles = new Map<string, string>();
  vfiles.set(join(VROOT, 'types', 'drobek.d.ts'), bundle.dts);
  for (const m of modules) {
    if (m.sdk?.inline) vfiles.set(join(VROOT, 'types', 'inline', `${m.name}.d.ts`), m.sdk.inline.types.trim() + '\n');
  }
  const options = tsOptions();
  const probeHost = virtualHost(options, vfiles);
  const shims = new Set<string>();
  for (const u of codeUnits) {
    for (const spec of bareImports(u.block.code)) {
      if (spec === 'drobek' || spec.startsWith('drobek/')) continue;
      const r = ts.resolveModuleName(spec, join(VROOT, 'probe.ts'), options, probeHost);
      if (!r.resolvedModule) shims.add(spec);
    }
  }
  vfiles.set(
    join(VROOT, 'types', 'shims.d.ts'),
    ["declare module '*.css';", ...[...shims].map((s) => `declare module ${JSON.stringify(s)};`)].join('\n') + '\n'
  );
  for (const u of codeUnits) {
    vfiles.set(u.vpath, hasModuleSyntax(u.block.code) ? u.block.code : `${u.block.code}export {};\n`);
    for (const [p, text] of u.files) if (p.endsWith('.css')) vfiles.set(join(dirname(u.vpath), posix.relative(posix.dirname(u.path), p)), text);
  }
  for (const a of apiUnits) {
    vfiles.set(a.docPath, a.block.code);
    vfiles.set(a.checkPath, a.check);
  }
  const roots = [join(VROOT, 'types', 'shims.d.ts'), ...codeUnits.map((u) => u.vpath), ...apiUnits.map((a) => a.checkPath)];
  const program = ts.createProgram({ rootNames: roots, options, host: virtualHost(options, vfiles) });
  for (const d of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) {
    problems.push({ skill: '(typescript)', file: '(program)', block: -1, line: 0, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') });
  }
  const diagnosticsOf = (path: string): TS.Diagnostic[] => {
    const sf = program.getSourceFile(path);
    if (!sf) return [];
    return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
  };
  const lineOf = (d: TS.Diagnostic) => (d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line : 0);

  // The SDK declarations themselves must be valid (e.g. no global JSX under React 19 types).
  for (const [path] of vfiles) {
    if (!path.includes(`${join('.virtual', 'types')}`) || path.endsWith('shims.d.ts')) continue;
    for (const d of diagnosticsOf(path)) {
      problems.push({
        skill: '(sdk types)',
        file: path.slice(VROOT.length + 1),
        block: -1,
        line: lineOf(d) + 1,
        message: `tsc: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
      });
    }
  }
  for (const u of codeUnits) {
    counts.typechecked++;
    for (const d of diagnosticsOf(u.vpath)) {
      problems.push(problem(u.skill, u.block, `tsc TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`, lineOf(d) + 1));
    }
  }
  for (const a of apiUnits) {
    counts.apiChecked++;
    for (const d of diagnosticsOf(a.docPath)) {
      problems.push(problem(a.skill, a.block, `tsc TS${d.code} in the api block: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`, lineOf(d) + 1));
    }
    for (const d of diagnosticsOf(a.checkPath)) {
      const name = a.names.get(lineOf(d));
      const text = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      const target = a.block.code.split('\n')[0].replace(/^\/\/\s*/, '').trim();
      problems.push(
        problem(
          a.skill,
          a.block,
          name && /not assignable to type 'false'/.test(text)
            ? `the documented \`${name}\` differs from the real \`${name}\` of ${target} in sdk.d.ts`
            : `api check${name ? ` of \`${name}\`` : ''} against ${target}: ${text}`
        )
      );
    }
  }
  return { problems, counts };
}
