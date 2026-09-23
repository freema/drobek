/**
 * The drobek browser SDK core (M1-01, NSO-287) — bundled into every server's
 * `/__drobek/sdk.js` together with the `sdk.entry` of each ACTIVE platform
 * module (`@drobek/modules` composes it with esbuild at startup). An app imports
 * it as `import { drobek } from 'drobek'` (the compiler maps the bare `drobek`
 * to the versioned `/__drobek/sdk.js?v=<hash>`).
 *
 * Runs in the BROWSER on the app's own origin. It holds no tokens: the end-user
 * session is an HttpOnly cookie on the app host, so every call is a
 * same-origin `fetch` with `credentials: 'same-origin'`. Every request carries
 * `X-Drobek-SDK: 1` — the module router refuses mutations without it (a
 * cross-site page cannot set a custom header without a CORS preflight, which
 * the apps origin never grants).
 */

/** The header every SDK request carries (the router's CSRF guard checks it). */
export const SDK_HEADER = 'X-Drobek-SDK';
/** Module routes live under `/__drobek/v1/<module>/…` on the app's own host. */
export const MODULE_API_BASE = '/__drobek/v1';

/**
 * A failed module call: `status` is the HTTP status, `code` the stable error
 * code from the module (`{ error, message, details?, hint? }`), `hint` what to
 * do (for agents: usually `skill_info('<module>')`).
 */
export class DrobekError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly hint?: string;

  constructor(status: number, code: string, message: string, details?: unknown, hint?: string) {
    super(message);
    this.name = 'DrobekError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (hint !== undefined) this.hint = hint;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  /** Query parameters (null/undefined are skipped). */
  query?: Record<string, QueryValue>;
  /** JSON body (sent with `Content-Type: application/json`); a `FormData` is sent as multipart/form-data. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** What a module's SDK entry receives: a fetch wrapper scoped to its own routes. */
export interface SdkCore {
  /** The module name (`drobek.<module>`). */
  readonly module: string;
  /** `/__drobek/v1/<module><path>?<query>` */
  url(path?: string, query?: Record<string, QueryValue>): string;
  /**
   * Call a route of this module. Resolves with the parsed JSON body (text for a
   * non-JSON body, undefined for 204); rejects with DrobekError on a non-2xx.
   */
  request<T = unknown>(method: string, path?: string, opts?: RequestOptions): Promise<T>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function joinPath(path: string | undefined): string {
  if (!path) return '';
  return path.startsWith('/') ? path : `/${path}`;
}

function queryString(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined) continue;
    params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
  return res.text();
}

/** The SDK core for module `module` (the composed sdk.js calls this once per module). */
export function createCore(module: string, fetchImpl?: FetchLike): SdkCore {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  const url = (path?: string, query?: Record<string, QueryValue>) =>
    `${MODULE_API_BASE}/${module}${joinPath(path)}${queryString(query)}`;
  return {
    module,
    url,
    async request<T>(method: string, path?: string, opts: RequestOptions = {}): Promise<T> {
      const headers: Record<string, string> = { Accept: 'application/json', [SDK_HEADER]: '1', ...opts.headers };
      const init: RequestInit = { method: method.toUpperCase(), headers, credentials: 'same-origin' };
      if (opts.signal) init.signal = opts.signal;
      if (typeof FormData !== 'undefined' && opts.body instanceof FormData) {
        // multipart/form-data: the browser sets the Content-Type with its boundary.
        init.body = opts.body;
      } else if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      const res = await doFetch(url(path, opts.query), init);
      const body = await readBody(res);
      if (!res.ok) {
        const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        throw new DrobekError(
          res.status,
          typeof b.error === 'string' ? b.error : 'http_error',
          typeof b.message === 'string' ? b.message : `${res.status} ${res.statusText}`.trim(),
          b.details,
          typeof b.hint === 'string' ? b.hint : undefined
        );
      }
      return body as T;
    },
  };
}
