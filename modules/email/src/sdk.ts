/**
 * The browser half of the email module: bundled into `/__drobek/sdk.js` as
 * `drobek.email` by the drobek server at start. There is deliberately no
 * "send to an address" call: an app can only notify its own owners.
 */
import type { SdkCore } from '@drobek/sdk';

export interface EmailApi {
  notifyAdmins(subject: string, text: string): Promise<{ sent: number }>;
}

export default function email(core: SdkCore): EmailApi {
  return {
    notifyAdmins(subject, text) {
      return core.request<{ sent: number }>('POST', '/notify-admins', { body: { subject, text } });
    },
  };
}
