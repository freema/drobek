import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { SDK_URL, readAppConfig } from './config.js';
import { limitsFromEnv, type CompileLimits } from './limits.js';
import { isAllowedExt, normalizeAppPath, TEXT_EXTS, extOf } from './paths.js';
import { APP_NAMESPACE, SDK_SOURCE_NAMESPACE, virtualFsPlugin, type FailDetail, type VirtualFsState } from './plugin.js';
import { Semaphore } from './queue.js';
import { scanForSecrets } from './secrets.js';
import type {
  CompileErrorCode,
  CompileMessage,
  CompileOptions,
  CompileResult,
  SourceFiles,
} from './types.js';

const OUT_DIR = '/__drobek_out';
const KNOWN_CODES = new Set<CompileErrorCode>([
  'build_error',
  'unresolved_import',
  'limit_exceeded',
  'secret_in_source',
  'invalid_path',
  'invalid_config',
  'timeout',
  'busy',
]);
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface CompileHooks {
  /** Test seam: awaited before esbuild loads each app file. */
  beforeLoad?: (path: string) => Promise<void>;
}

function failed(errors: CompileMessage[], started: number): CompileResult {
  return {
    ok: false,
    outputs: new Map(),
    errors,
    warnings: [],
    inputs: [],
    durationMs: Date.now() - started,
  };
}

function fromEsbuild(messages: esbuild.Message[]): CompileMessage[] {
  return messages.map((m) => {
    const detail = (m.detail && typeof m.detail === 'object' ? m.detail : { code: m.detail }) as Partial<FailDetail>;
    const code = KNOWN_CODES.has(detail.code as CompileErrorCode)
      ? (detail.code as CompileErrorCode)
      : 'build_error';
    const out: CompileMessage = { code, text: m.text };
    if (typeof detail.specifier === 'string') out.specifier = detail.specifier;
    if (m.location) {
      out.file = m.location.file.replace(new RegExp(`^(?:${APP_NAMESPACE}|${SDK_SOURCE_NAMESPACE}):`), '');
      out.line = m.location.line;
      out.column = m.location.column;
      out.lineText = m.location.lineText;
    }
    return out;
  });
}

/**
 * In-process esbuild compiler for app sources. The output is only ever SERVED
 * to browsers — nothing here (or anywhere on the server) executes it.
 */
export class Compiler {
  readonly limits: CompileLimits;
  private readonly slots: Semaphore;
  /** Empty, never-written directory: esbuild's cwd, so no relative path can hit real files. */
  private readonly workDir: string;

  constructor(limits: Partial<CompileLimits> = {}) {
    this.limits = { ...limitsFromEnv(), ...limits };
    this.slots = new Semaphore(this.limits.concurrency, this.limits.queueTimeoutMs);
    this.workDir = mkdtempSync(join(tmpdir(), 'drobek-compile-'));
  }

  stats(): { active: number; queued: number; maxActive: number } {
    return this.slots.stats();
  }

  async compile(
    input: SourceFiles,
    opts: CompileOptions = {},
    hooks: CompileHooks = {}
  ): Promise<CompileResult> {
    const started = Date.now();
    const checked = this.validate(input);
    if (checked.errors.length > 0) return failed(checked.errors, started);

    const secrets = [...checked.text].flatMap(([path, text]) => scanForSecrets(path, text));
    if (secrets.length > 0) return failed(secrets, started);

    const { config, errors: configErrors } = readAppConfig(checked.text);
    if (configErrors.length > 0) return failed(configErrors, started);

    if (Object.keys(config.entries).length === 0) {
      // A plain static app (index.html + assets) has nothing to bundle.
      return { ok: true, outputs: new Map(), errors: [], warnings: [], inputs: [], durationMs: 0 };
    }

    if (!(await this.slots.acquire())) {
      return failed(
        [{ code: 'busy', text: 'The compiler is busy — retry the write in a few seconds.' }],
        started
      );
    }
    try {
      return await this.build(checked.all, config, opts, hooks, started);
    } finally {
      this.slots.release();
    }
  }

  /** Paths, extensions, UTF-8 and size limits — all before esbuild starts. */
  private validate(input: SourceFiles): {
    errors: CompileMessage[];
    all: Map<string, string | Buffer>;
    text: Map<string, string>;
  } {
    const errors: CompileMessage[] = [];
    const all = new Map<string, string | Buffer>();
    const text = new Map<string, string>();
    const L = this.limits;

    if (input.size > L.maxFiles) {
      errors.push({
        code: 'limit_exceeded',
        text: `${input.size} files exceeds the limit of ${L.maxFiles} files per app.`,
      });
      return { errors, all, text };
    }

    let total = 0;
    for (const [raw, content] of input) {
      const path = normalizeAppPath(raw);
      if (!path) {
        errors.push({ code: 'invalid_path', file: raw, text: `Unsafe path ${JSON.stringify(raw)}.` });
        continue;
      }
      if (!isAllowedExt(path)) {
        errors.push({
          code: 'invalid_path',
          file: path,
          text: `File type "${extOf(path) || '(none)'}" is not allowed in an app.`,
        });
        continue;
      }
      const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.length;
      total += bytes;
      if (bytes > L.maxFileBytes) {
        errors.push({
          code: 'limit_exceeded',
          file: path,
          text: `${bytes} bytes exceeds the per-file limit of ${L.maxFileBytes} bytes.`,
        });
        continue;
      }
      if (TEXT_EXTS.has(extOf(path))) {
        let decoded: string;
        try {
          decoded = typeof content === 'string' ? content : utf8.decode(content);
        } catch {
          errors.push({ code: 'invalid_path', file: path, text: 'Text file is not valid UTF-8.' });
          continue;
        }
        text.set(path, decoded);
        all.set(path, decoded);
      } else {
        all.set(path, typeof content === 'string' ? Buffer.from(content) : content);
      }
    }
    if (total > L.maxTotalBytes) {
      errors.unshift({
        code: 'limit_exceeded',
        text: `${total} bytes in total exceeds the per-app limit of ${L.maxTotalBytes} bytes.`,
      });
    }
    return { errors, all, text };
  }

  private async build(
    files: Map<string, string | Buffer>,
    config: { imports: Record<string, string>; entries: Record<string, string>; beacon?: boolean },
    opts: CompileOptions,
    hooks: CompileHooks,
    started: number
  ): Promise<CompileResult> {
    let abortBuild!: () => void;
    const state: VirtualFsState = {
      files,
      imports: config.imports,
      sdkUrl: opts.sdkUrl ?? SDK_URL,
      sdkSources: opts.sdkSources ?? {},
      maxImportDepth: this.limits.maxImportDepth,
      loaded: new Set(),
      aborted: false,
      abort: new Promise<void>((resolve) => (abortBuild = resolve)),
      beforeLoad: hooks.beforeLoad,
    };

    const ctx = await esbuild.context({
      entryPoints: config.entries,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      sourcemap: opts.sourcemap === false ? false : 'inline',
      minify: opts.minify ?? false,
      outdir: OUT_DIR,
      entryNames: '[name]',
      assetNames: 'assets/[name]-[hash]',
      publicPath: '/',
      charset: 'utf8',
      absWorkingDir: this.workDir,
      nodePaths: [],
      tsconfigRaw: '{}',
      logLevel: 'silent',
      plugins: [virtualFsPlugin(state)],
      // M1-07: every entry loads the error beacon first (ES imports run in order).
      ...(opts.beaconUrl && config.beacon !== false ? { banner: { js: `import ${JSON.stringify(opts.beaconUrl)};` } } : {}),
    });

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.limits.timeoutMs);
    });
    const run = ctx.rebuild().then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    const outcome = await Promise.race([run, timedOut]);
    clearTimeout(timer);

    if (outcome === 'timeout') {
      // Stop only THIS build (a global esbuild.stop() would kill healthy
      // concurrent compiles too); plugin callbacks bail out on `aborted`.
      state.aborted = true;
      abortBuild();
      void ctx.cancel().finally(() => ctx.dispose());
      return failed(
        [
          {
            code: 'timeout',
            text: `Compilation took longer than ${this.limits.timeoutMs} ms and was stopped. Check for an import cycle or a very large file.`,
          },
        ],
        started
      );
    }
    await ctx.dispose();

    const inputs = [...state.loaded];
    if ('error' in outcome) {
      const failure = outcome.error as Partial<esbuild.BuildFailure>;
      const errors = failure.errors?.length
        ? fromEsbuild(failure.errors)
        : [{ code: 'build_error' as const, text: String((outcome.error as Error)?.message ?? outcome.error) }];
      return {
        ok: false,
        outputs: new Map(),
        errors,
        warnings: fromEsbuild(failure.warnings ?? []),
        inputs,
        durationMs: Date.now() - started,
      };
    }

    const outputs = new Map<string, Buffer>();
    for (const file of outcome.result.outputFiles ?? []) {
      outputs.set(file.path.slice(OUT_DIR.length + 1), Buffer.from(file.contents));
    }
    return {
      ok: true,
      outputs,
      errors: [],
      warnings: fromEsbuild(outcome.result.warnings),
      inputs,
      durationMs: Date.now() - started,
    };
  }
}

let shared: Compiler | null = null;

/** Compile with the process-wide compiler (limits from `COMPILE_*` env). */
export function compile(
  files: SourceFiles,
  opts?: CompileOptions,
  hooks?: CompileHooks
): Promise<CompileResult> {
  shared ??= new Compiler();
  return shared.compile(files, opts, hooks);
}
