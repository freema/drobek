/**
 * The TypeScript check of one app version (NSO-388). It builds a program over
 * the in-memory file map + the server's SDK declarations + @types/react and
 * reports the diagnostics of the app's .ts/.tsx files. The checker only
 * analyses the sources — app code is never executed.
 */
import { createRequire } from 'node:module';
import { dirname, posix } from 'node:path';
import type TS from 'typescript';

/** The declarations of this server's SDK: `drobek` and each `drobek/<module>` inline import. */
export interface TypecheckSdk {
  dts: string;
  /** Module name → the declarations of `drobek/<name>`. */
  inline: Record<string, string>;
}

/** A type error in an app file (1-based line). */
export interface TypeFinding {
  file: string;
  line: number;
  message: string;
}

export interface TypecheckOutput {
  findings: TypeFinding[];
  /** Every type error found; `findings` keeps the first `maxFindings`. */
  total: number;
}

const VROOT = '/__drobek_app';
const TYPES_DIR = `${VROOT}/__drobek_types`;
const MESSAGE_MAX = 400;
const ASSET_EXTS = ['css', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'woff', 'woff2', 'txt', 'md', 'html', 'webmanifest'];

/** The files the check reports on. JS-only apps have none and are not checked. */
export function isTypeScriptPath(path: string): boolean {
  return /\.(ts|tsx|mts|cts)$/i.test(path);
}

function isCheckInput(path: string): boolean {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|json)$/i.test(path);
}

let ts: typeof TS | undefined;
async function loadTypescript(): Promise<typeof TS> {
  ts ??= ((await import('typescript')) as unknown as { default: typeof TS }).default;
  return ts;
}

/** Where @types/react and @types/react-dom live (absent → React imports are untyped). */
function reactTypes(): { react?: string; reactDom?: string } {
  const require = createRequire(import.meta.url);
  const dir = (pkg: string): string | undefined => {
    try {
      return dirname(require.resolve(`${pkg}/package.json`));
    } catch {
      return undefined;
    }
  };
  const react = dir('@types/react');
  return { react, reactDom: react ? dir('@types/react-dom') : undefined };
}

function compilerOptions(t: typeof TS, react: { react?: string; reactDom?: string }): TS.CompilerOptions {
  const paths: Record<string, string[]> = {
    drobek: [`${TYPES_DIR}/drobek.d.ts`],
    'drobek/*': [`${TYPES_DIR}/inline/*.d.ts`],
  };
  if (react.react) {
    paths.react = [`${react.react}/index.d.ts`];
    paths['react/*'] = [`${react.react}/*`];
  }
  if (react.reactDom) {
    paths['react-dom'] = [`${react.reactDom}/index.d.ts`];
    paths['react-dom/*'] = [`${react.reactDom}/*`];
  }
  return {
    target: t.ScriptTarget.ES2022,
    module: t.ModuleKind.ESNext,
    moduleResolution: t.ModuleResolutionKind.Bundler,
    jsx: t.JsxEmit.ReactJSX,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    strict: true,
    // An implicit `any` is not a runtime bug; the check reports what breaks in the browser.
    noImplicitAny: false,
    noEmit: true,
    allowJs: true,
    checkJs: false,
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    isolatedModules: true,
    skipLibCheck: true,
    baseUrl: VROOT,
    paths,
  };
}

/** Library files (lib.dom.d.ts, @types/react) parse once per worker; every check reuses them. */
const libCache = new Map<string, TS.SourceFile>();

function virtualHost(t: typeof TS, opts: TS.CompilerOptions, vfiles: Map<string, string>): TS.CompilerHost {
  const base = t.createCompilerHost(opts, true);
  const vdirs = new Set<string>([VROOT]);
  for (const f of vfiles.keys()) for (let d = posix.dirname(f); d.startsWith(VROOT); d = posix.dirname(d)) vdirs.add(d);
  const isVirtual = (p: string) => p === VROOT || p.startsWith(`${VROOT}/`);
  return {
    ...base,
    getCurrentDirectory: () => VROOT,
    fileExists: (f) => (isVirtual(f) ? vfiles.has(f) : base.fileExists(f)),
    readFile: (f) => (isVirtual(f) ? vfiles.get(f) : base.readFile(f)),
    directoryExists: (d) => (isVirtual(d) ? vdirs.has(d) : base.directoryExists ? base.directoryExists(d) : true),
    getDirectories: (d) => (isVirtual(d) ? [] : base.getDirectories ? base.getDirectories(d) : []),
    realpath: (p) => (isVirtual(p) ? p : base.realpath ? base.realpath(p) : p),
    writeFile: () => {},
    getSourceFile(f, lang, onError) {
      if (isVirtual(f)) {
        const text = vfiles.get(f);
        return text === undefined ? undefined : t.createSourceFile(f, text, lang, true);
      }
      const key = `${typeof lang === 'object' ? lang.languageVersion : lang}:${f}`;
      let sf = libCache.get(key);
      if (!sf) {
        sf = base.getSourceFile(f, lang, onError);
        if (sf) libCache.set(key, sf);
      }
      return sf;
    },
  };
}

function messageOf(t: typeof TS, d: TS.Diagnostic): string {
  const text = t.flattenDiagnosticMessageText(d.messageText, ' ').replace(/\s+/g, ' ').trim();
  const msg = `TS${d.code}: ${text}`;
  return msg.length > MESSAGE_MAX ? `${msg.slice(0, MESSAGE_MAX - 1)}…` : msg;
}

/**
 * Type errors of the app's .ts/.tsx files, ordered by file and line. A bare
 * or URL import the program cannot resolve (an import-map entry without
 * types) is untyped, and asset imports (`./styles.css`, images) are plain
 * modules — only what TypeScript can know is reported.
 */
export async function typecheckApp(
  files: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  sdk: TypecheckSdk,
  maxFindings: number
): Promise<TypecheckOutput> {
  const entries = files instanceof Map ? [...files] : Object.entries(files);
  const vfiles = new Map<string, string>();
  const roots: string[] = [];
  for (const [path, text] of entries) {
    if (!isCheckInput(path) || typeof text !== 'string') continue;
    const v = `${VROOT}/${path}`;
    vfiles.set(v, text);
    if (isTypeScriptPath(path)) roots.push(v);
  }
  if (roots.length === 0) return { findings: [], total: 0 };

  const t = await loadTypescript();
  vfiles.set(`${TYPES_DIR}/drobek.d.ts`, sdk.dts);
  for (const [name, types] of Object.entries(sdk.inline)) vfiles.set(`${TYPES_DIR}/inline/${name}.d.ts`, `${types.trim()}\n`);
  const opts = compilerOptions(t, reactTypes());

  const probe = virtualHost(t, opts, vfiles);
  const shims = new Set<string>();
  for (const root of roots) {
    for (const ref of t.preProcessFile(vfiles.get(root) ?? '', true, true).importedFiles) {
      const spec = ref.fileName;
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      if (!t.resolveModuleName(spec, root, opts, probe).resolvedModule) shims.add(spec);
    }
  }
  const shimPath = `${TYPES_DIR}/shims.d.ts`;
  vfiles.set(
    shimPath,
    [
      ...ASSET_EXTS.map((ext) => `declare module '*.${ext}' { const url: string; export default url; }`),
      ...[...shims].map((s) => `declare module ${JSON.stringify(s)} { const value: any; export = value; }`),
    ].join('\n') + '\n'
  );

  const program = t.createProgram({ rootNames: [shimPath, ...roots], options: opts, host: virtualHost(t, opts, vfiles) });
  const found: TypeFinding[] = [];
  for (const root of roots) {
    const sf = program.getSourceFile(root);
    if (!sf) continue;
    for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
      if (d.category !== t.DiagnosticCategory.Error) continue;
      const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 1;
      found.push({ file: root.slice(VROOT.length + 1), line, message: messageOf(t, d) });
    }
  }
  found.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { findings: found.slice(0, Math.max(0, maxFindings)), total: found.length };
}
