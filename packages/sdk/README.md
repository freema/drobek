# @drobek/sdk

The browser SDK core of [drobek](https://github.com/freema/drobek): the
`SdkCore` a platform module's SDK entry receives (`core.request(method,
path, { body, query })`), `DrobekError` and the beacon (page loads, browser
errors, failed resource loads and CSP blocks, with the page's version). The drobek
server bundles it with the SDK entries of its modules into
`/__drobek/sdk.js`, which apps import as `drobek`.

Published on npm as `@freema/drobek-sdk`. `@drobek/modules` re-exports
`SdkCore`, so most modules never install it; one that imports
`@drobek/sdk` directly adds it under that name with an npm alias:
`"@drobek/sdk": "npm:@freema/drobek-sdk@^X.Y.Z"`.

A module's SDK entry needs only the type:

```ts
import type { SdkCore } from '@drobek/sdk';

export default function erp(core: SdkCore) {
  return { orders: () => core.request<{ id: string }[]>('GET', '/orders') };
}
```

The guide is
[Writing a module](https://github.com/freema/drobek/blob/main/docs/MODULES.md#writing-a-module).
Licence: AGPL-3.0-only.
