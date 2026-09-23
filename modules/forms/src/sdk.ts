/**
 * The browser half of the forms module: bundled into `/__drobek/sdk.js` as
 * `drobek.forms` by the drobek server at start. It fetches the form's time
 * token (`prepare`, early — e.g. when the form mounts), waits until the
 * token is old enough, and posts the fields as JSON. A stale or missing
 * token is refreshed once automatically.
 */
import { DrobekError, type SdkCore } from '@drobek/sdk/core';

export type FieldValue = string | number | boolean | null | string[];

export interface SubmitResult {
  ok: true;
  id: string;
}

export interface Submission {
  id: string;
  created_at: string;
  data: Record<string, FieldValue>;
  user_id: string | null;
  notified: boolean;
}

export interface FormsApi {
  prepare(form: string): Promise<void>;
  submit(form: string, data: Record<string, FieldValue> | FormData): Promise<SubmitResult>;
  submissions(form: string, opts?: { limit?: number; before?: string }): Promise<{ submissions: Submission[]; next_cursor: string | null }>;
  csvUrl(form: string): string;
}

interface Token {
  token: string;
  /** When the token may be used (client clock). */
  readyAt: number;
  /** When it should be replaced (client clock, with a margin). */
  staleAt: number;
}

interface TokenResponse {
  token: string;
  min_wait_ms: number;
  expires_in: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** FormData → a plain object (repeated names → lists). Files are refused: use the files module. */
function fromFormData(fd: FormData): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  fd.forEach((value, name) => {
    if (typeof value !== 'string') {
      throw new DrobekError(400, 'invalid_request', `The field "${name}" is a file; forms take text fields only (upload files with the files module and submit the id).`);
    }
    const prev = Object.prototype.hasOwnProperty.call(out, name) ? out[name] : undefined;
    if (prev === undefined) out[name] = value;
    else out[name] = Array.isArray(prev) ? [...prev, value] : [String(prev), value];
  });
  return out;
}

function codeOf(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : '';
}

export default function forms(core: SdkCore): FormsApi {
  const tokens = new Map<string, Promise<Token>>();
  const path = (form: string, rest = '') => `/${encodeURIComponent(form)}${rest}`;

  function fetchToken(form: string): Promise<Token> {
    const p = core.request<TokenResponse>('GET', path(form, '/token')).then((r) => {
      const now = Date.now();
      return { token: r.token, readyAt: now + r.min_wait_ms + 100, staleAt: now + r.expires_in * 1000 - 5 * 60_000 };
    });
    tokens.set(form, p);
    p.catch(() => {
      if (tokens.get(form) === p) tokens.delete(form);
    });
    return p;
  }

  async function token(form: string): Promise<Token> {
    const cached = tokens.get(form);
    if (cached) {
      const t = await cached.catch(() => null);
      if (t && t.staleAt > Date.now()) return t;
    }
    return fetchToken(form);
  }

  async function post(form: string, data: Record<string, FieldValue>): Promise<SubmitResult> {
    const t = await token(form);
    const wait = t.readyAt - Date.now();
    if (wait > 0) await sleep(wait);
    return core.request<SubmitResult>('POST', path(form), { body: { ...data, _t: t.token } });
  }

  return {
    async prepare(form) {
      await token(form);
    },
    async submit(form, input) {
      const data: Record<string, FieldValue> =
        typeof FormData !== 'undefined' && input instanceof FormData ? fromFormData(input) : { ...(input as Record<string, FieldValue>) };
      if (!('_hp' in data)) data._hp = '';
      try {
        return await post(form, data);
      } catch (err) {
        const code = codeOf(err);
        if (code === 'invalid_form_token') {
          tokens.delete(form);
          return post(form, data);
        }
        if (code === 'submitted_too_fast') {
          // The server's clock says the token is still too young (clock skew): wait once more.
          await sleep(2000);
          return post(form, data);
        }
        throw err;
      }
    },
    submissions(form, opts = {}) {
      return core.request('GET', path(form, '/submissions'), { query: { limit: opts.limit, before: opts.before } });
    },
    csvUrl(form) {
      return core.url(path(form, '/submissions.csv'));
    },
  };
}
