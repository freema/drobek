/**
 * The browser half of the hello module: bundled into `/__drobek/sdk.js` as
 * `drobek.hello` by the drobek server at start. Runs in the app's page — keep
 * it dependency-free (type imports only).
 */
import type { SdkCore } from '@drobek/modules';

export interface Hello {
  greeting: string;
  message: string;
  waves: number;
  signed: boolean;
  signature?: string;
}

/** The visitor as every platform module sees them (signed in through the auth module, or not). */
export type Visitor = { signed_in: false } | { signed_in: true; id: string; email: string; role: 'user' | 'admin' };

export default function hello(core: SdkCore) {
  return {
    ping: () => core.request<Hello>('GET', '/'),
    whoami: () => core.request<Visitor>('GET', '/whoami'),
    wave: (name: string) => core.request<{ waves: number }>('POST', '/wave', { body: { name } }),
    greet: (name: string, greeter?: string) =>
      core.request<{ text: string; greeter: string | null }>('GET', '/greet', { query: greeter === undefined ? { name } : { name, greeter } }),
  };
}
