/**
 * The browser half of the module: the drobek server bundles it into
 * `/__drobek/sdk.js` as `drobek.acmecrm`. It runs in the app's page — keep
 * it dependency-free (type imports only). The declared types are SDK_TYPES
 * in src/index.ts.
 */
import type { SdkCore } from '@drobek/modules';

export interface Contact {
  id: number;
  email: string;
  name: string | null;
  source: 'app' | 'sign-in';
  tags: string[];
  fields: Record<string, string>;
  created_at: string;
}

export interface NewContact {
  email: string;
  name?: string;
  fields?: Record<string, string>;
}

export default function sdk(core: SdkCore) {
  return {
    list: () => core.request<{ contacts: Contact[]; upstream: boolean }>('GET', '/'),
    add: (contact: NewContact) => core.request<Contact>('POST', '/', { body: contact }),
  };
}
