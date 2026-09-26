/**
 * The browser half of the module: the drobek server bundles it into
 * `/__drobek/sdk.js` as `drobek.{{module}}`. It runs in the app's page — keep
 * it dependency-free (type imports only). The declared types are SDK_TYPES
 * in src/index.ts.
 */
import type { SdkCore } from '@drobek/modules';

export interface Item {
  id: number;
  title: string;
  created_at: string;
}

export default function sdk(core: SdkCore) {
  return {
    list: () => core.request<{ items: Item[]; upstream: boolean }>('GET', '/items'),
    add: (title: string) => core.request<Item>('POST', '/items', { body: { title } }),
  };
}
