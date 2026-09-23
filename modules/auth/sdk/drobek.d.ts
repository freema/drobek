// Type-check shim for sdk/auth.tsx: in an app, the bare `drobek` import is the
// server's /__drobek/sdk.js (the auth slice is src/sdk.ts).
import type { AuthApi } from '../src/sdk.js';

export declare class DrobekError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly hint?: string;
}

export declare const drobek: { readonly auth: AuthApi };
export default drobek;
