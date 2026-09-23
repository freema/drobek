/** Error codes an agent can branch on (`compile.errors[].code`). */
export type CompileErrorCode =
  /** esbuild parse/transform error (syntax, invalid CSS/JSON, …). */
  | 'build_error'
  /** Import not in the app's files nor in `drobek.json` `imports`. */
  | 'unresolved_import'
  /** File count/size, total size or import depth over the limit. */
  | 'limit_exceeded'
  /** A credential-looking string in source — the version is not stored. */
  | 'secret_in_source'
  /** Unsafe/unsupported path, disallowed extension or non-UTF-8 text. */
  | 'invalid_path'
  /** `drobek.json` is not valid JSON or has an invalid shape. */
  | 'invalid_config'
  /** The build ran longer than `timeoutMs`. */
  | 'timeout'
  /** Waited longer than `queueTimeoutMs` for a compile slot. */
  | 'busy';

export interface CompileMessage {
  code: CompileErrorCode;
  text: string;
  /** App-relative path, e.g. `src/main.tsx`. */
  file?: string;
  /** 1-based line (as esbuild reports it). */
  line?: number;
  /** 0-based column (as esbuild reports it). */
  column?: number;
  lineText?: string;
  /** `unresolved_import` only: the import specifier that could not be resolved (e.g. `firebase/app`). */
  specifier?: string;
}

export interface CompileResult {
  ok: boolean;
  /** Output path (e.g. `main.js`, `main.css`, `assets/logo-HASH.png`) → bytes. */
  outputs: Map<string, Buffer>;
  errors: CompileMessage[];
  warnings: CompileMessage[];
  /** App paths esbuild actually loaded (always a subset of the input files). */
  inputs: string[];
  durationMs: number;
}

export interface CompileOptions {
  /** Inline source maps (preview). Publish compiles without. Default true. */
  sourcemap?: boolean;
  minify?: boolean;
  /**
   * What the bare `drobek` import becomes (M1-01): the server's versioned SDK
   * URL, e.g. `/__drobek/sdk.js?v=3f2a…` (immutable caching). Default
   * `SDK_URL` (unversioned).
   */
  sdkUrl?: string;
}

export type SourceFiles = Map<string, string | Buffer>;
