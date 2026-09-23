/** SDK entry of the test module (bundled by buildSdk in the tests). */
import type { SdkCore } from '@drobek/sdk';

export default function echo(core: SdkCore) {
  return { hi: () => core.request('GET', '/') };
}
