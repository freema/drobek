# @drobek/sdk

The browser SDK core of [drobek](https://github.com/freema/drobek): the
`SdkCore` a platform module's SDK entry receives (`core.request(method,
path, { body, query })`), `DrobekError` and the error beacon. The drobek
server bundles it with the SDK entries of its modules into
`/__drobek/sdk.js`, which apps import as `drobek`.

A module's SDK entry needs only the type:

```ts
import type { SdkCore } from '@drobek/sdk';

export default function erp(core: SdkCore) {
  return { orders: () => core.request<{ id: string }[]>('GET', '/orders') };
}
```

`SdkCore` is re-exported by `@drobek/modules` too. The guide is
[Writing a module](https://github.com/freema/drobek/blob/main/docs/MODULES.md#writing-a-module).
Licence: AGPL-3.0-only.
