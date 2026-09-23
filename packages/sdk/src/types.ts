/**
 * The TypeScript declarations of the SDK core, as the text the composed
 * `/__drobek/sdk.d.ts` starts with (M1-01). Kept next to core.ts; the
 * `@drobek/modules` sdk tests parse the composed file and check that it
 * declares everything core.ts exports to apps.
 */
export const CORE_SDK_TYPES = `/** A failed module call. \`code\` is the stable error code, \`hint\` what to do. */
export declare class DrobekError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly hint?: string;
}`;
