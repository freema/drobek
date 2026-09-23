/**
 * The browser half of the hello module: bundled into `/__drobek/sdk.js` as
 * `drobek.hello` by the drobek server at start. Runs in the app's page — keep
 * it dependency-free (type imports only).
 */
import type { SdkCore } from '@drobek/sdk';

export interface Hello {
  greeting: string;
  message: string;
  waves: number;
  signed: boolean;
  signature?: string;
}

export default function hello(core: SdkCore) {
  return {
    ping: () => core.request<Hello>('GET', '/'),
    wave: (name: string) => core.request<{ waves: number }>('POST', '/wave', { body: { name } }),
  };
}
