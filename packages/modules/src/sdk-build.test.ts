import { describe, expect, it } from 'vitest';
import { buildSdk, sdkDeclarations, sdkEntrySource } from './sdk-build.js';
import { echo, quiet } from './test/fixtures.js';

describe('SDK composition', () => {
  it('bundles ONLY the active modules; the hash + url change with the set', async () => {
    const none = await buildSdk([]);
    const withEcho = await buildSdk([echo, quiet]);
    expect(none.modules).toEqual([]);
    expect(withEcho.modules).toEqual(['echo']);
    expect(none.js.toString()).not.toContain('"echo"');
    expect(withEcho.js.toString()).toContain('"echo"');
    expect(withEcho.js.toString()).toContain('X-Drobek-SDK');
    expect(withEcho.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(withEcho.url).toBe(`/__drobek/sdk.js?v=${withEcho.hash}`);
    expect(none.hash).not.toBe(withEcho.hash);
    // deterministic
    expect((await buildSdk([echo])).hash).toBe(withEcho.hash);
  });

  it('the bundle is a self-contained ES module exporting drobek + DrobekError', async () => {
    const js = (await buildSdk([echo])).js.toString();
    expect(js).not.toMatch(/^\s*import\s/m);
    expect(js).toMatch(/export\s*\{[^}]*drobek[^}]*\}/);
    expect(js).toContain('DrobekError');
  });

  it('declarations: one namespace per module + the Drobek interface', () => {
    const dts = sdkDeclarations([echo, quiet]);
    expect(dts).toContain('export declare namespace echo {');
    expect(dts).toContain('readonly echo: echo.Api;');
    expect(dts).not.toContain('quiet');
    expect(dts).toContain('export declare const drobek: Drobek;');
    expect(dts).toContain('class DrobekError');
  });

  it('inline sources (`drobek/<module>`) are read for the compiler, NOT bundled into sdk.js', async () => {
    const sdk = await buildSdk([echo, quiet]);
    expect(Object.keys(sdk.inline)).toEqual(['drobek/echo']);
    expect(sdk.inline['drobek/echo']).toContain('export const Echo');
    expect(sdk.js.toString()).not.toContain('Echo = ');
    expect(sdk.dts).toContain("// ── import { … } from 'drobek/echo'");
    expect(sdk.dts).toContain('// export const Echo: () => null;');
    expect((await buildSdk([quiet])).inline).toEqual({});
  });

  it('composes the entry source', () => {
    expect(sdkEntrySource('/core.js', [echo]).replace(JSON.stringify(echo.sdk!.entry), '"<echo-sdk>"')).toMatchSnapshot();
  });
});
