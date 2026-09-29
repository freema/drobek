/**
 * The publish readiness report (NSO-384): one shape for write_files, publish
 * and the dashboard's app page. `blocking` is what already stops a version
 * today (compile errors; a credential is refused before anything is stored);
 * `warnings` never stop a write or a publish.
 */

/** One entry of the report: `code` is an error-catalogue code, `hint` its fix. */
export interface ReadinessFinding {
  code: string;
  file?: string;
  line?: number;
  message: string;
  hint: string;
}

export interface ReadinessReport {
  /** No blocking finding: the version compiled and can be published. */
  ready: boolean;
  blocking: ReadinessFinding[];
  warnings: ReadinessFinding[];
  /** Warnings left out above READINESS_MAX_WARNINGS (absent when none were). */
  warnings_omitted?: number;
  /**
   * NSO-388: the background TypeScript check of the version — `pending`
   * (running; ask again with get_app), `checked` (its `type_error` findings
   * are in `warnings`) or `unavailable` (not run: timeout, memory or file
   * limit). Absent when the version has nothing to check (no .ts/.tsx file,
   * or it did not compile) or the check is off.
   */
  typecheck?: 'pending' | 'checked' | 'unavailable';
}

/** A platform module as a check sees it: its effective config for the app. */
export interface ReadinessModule {
  name: string;
  enabled: boolean;
  config: unknown;
  /** The module's config changes still waiting for the owner's confirmation (not live). */
  pending?: readonly string[];
}

/** What every check reads — the version's source files and the app's module configs. Nothing else. */
export interface ReadinessInput {
  files: ReadonlyMap<string, string | Buffer>;
  modules: readonly ReadinessModule[];
}

/** A check's finding before the catalogue hint is attached. */
export type CheckFinding = Omit<ReadinessFinding, 'hint'>;

/**
 * One readiness check. It is deterministic and reads only `input` — it never
 * executes app code and never touches the network or the database.
 */
export interface ReadinessCheck {
  id: string;
  /** Every `code` the check can report; each needs an error-catalogue entry. */
  codes: readonly string[];
  /** Load the app's module configs for this check (skipped when no check needs them). */
  needsModules?: boolean;
  run(input: ReadinessInput): CheckFinding[] | Promise<CheckFinding[]>;
}
