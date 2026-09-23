// Type-check shim for sdk/forms.tsx: in an app, the bare `drobek` import is
// the server's /__drobek/sdk.js (the forms slice is src/sdk.ts).
import type { FormsApi } from '../src/sdk.js';

export declare class DrobekError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly hint?: string;
}

export declare const drobek: { readonly forms: FormsApi };
export default drobek;
