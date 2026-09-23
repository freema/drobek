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
  /**
   * Platform sources an app may import as `drobek/<module>` (M1-02): the
   * specifier → the source text of a module's `sdk.inline` (e.g. the auth
   * module's `<LoginGate>`). They are compiled INTO the app bundle: their bare
   * imports resolve through the app's `drobek.json` (so a component uses the
   * app's own React), `drobek` resolves to `sdkUrl`, relative imports are
   * refused. Read by the server from its own disk — never app input.
   */
  sdkSources?: Record<string, string>;
  /**
   * The browser error beacon script (M1-07), e.g. `/__drobek/beacon.js?v=…`:
   * when set, every JS entry starts with `import "<beaconUrl>";` so the app
   * reports its uncaught errors — unless the app's drobek.json has
   * `"beacon": false`. Unset = nothing is added.
   */
  beaconUrl?: string;
}

export type SourceFiles = Map<string, string | Buffer>;
