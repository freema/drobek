export type AppsErrorCode =
  | 'invalid_slug'
  | 'slug_taken'
  | 'invalid_path'
  | 'not_found'
  | 'not_publishable';

/** A caller-facing failure; `code` is stable (MCP tools return it verbatim). */
export class AppsError extends Error {
  readonly code: AppsErrorCode;
  /** For `slug_taken`: a free slug to offer instead (`<slug>-<4hex>`). */
  readonly suggestion?: string;

  constructor(code: AppsErrorCode, message: string, extra: { suggestion?: string } = {}) {
    super(message);
    this.name = 'AppsError';
    this.code = code;
    if (extra.suggestion) this.suggestion = extra.suggestion;
  }
}
