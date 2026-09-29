import { describe, expect, it } from 'vitest';
import { mayCarryInlineSourceMap, splitInlineSourceMap } from './sourcemap.js';

const MAP = JSON.stringify({ version: 3, sources: ['src/main.tsx'], sourcesContent: ['console.log("hi")'], mappings: 'AAAA' });
const B64 = Buffer.from(MAP).toString('base64');
const JS_CODE = 'console.log("hi");\n';
const CSS_CODE = 'body {\n  color: red;\n}\n';
const js = (trailer = `//# sourceMappingURL=data:application/json;base64,${B64}\n`) => Buffer.from(JS_CODE + trailer);
const css = (trailer = `/*# sourceMappingURL=data:application/json;base64,${B64} */\n`) => Buffer.from(CSS_CODE + trailer);

describe('splitInlineSourceMap', () => {
  it('JS: the code keeps every byte before the trailer and points at <file>.map; the map is the decoded JSON', () => {
    const split = splitInlineSourceMap(js(), 'main.js')!;
    expect(split.code.toString()).toBe(`${JS_CODE}//# sourceMappingURL=main.js.map\n`);
    expect(split.map.toString()).toBe(MAP);
  });

  it('CSS: the block-comment form', () => {
    const split = splitInlineSourceMap(css(), 'main.css')!;
    expect(split.code.toString()).toBe(`${CSS_CODE}/*# sourceMappingURL=main.css.map */\n`);
    expect(split.map.toString()).toBe(MAP);
  });

  it('names the map after the file (extra entries, nested paths), URL-encoded', () => {
    expect(splitInlineSourceMap(js(), 'admin.js')!.code.toString()).toContain('//# sourceMappingURL=admin.js.map\n');
    expect(splitInlineSourceMap(js(), 'x/my app+1.mjs')!.code.toString()).toContain(
      '//# sourceMappingURL=my%20app%2B1.mjs.map\n'
    );
  });

  it('accepts the charset form of the data URL and a missing final newline', () => {
    expect(splitInlineSourceMap(js(`//# sourceMappingURL=data:application/json;charset=utf-8;base64,${B64}`), 'main.js')?.map.toString()).toBe(MAP);
  });

  it('leaves a file without the exact trailer alone (null → served as stored)', () => {
    const cases: Array<[Buffer, string]> = [
      [Buffer.from(JS_CODE), 'main.js'],
      [js(`//# sourceMappingURL=main.js.map\n`), 'main.js'],
      [js(`//# sourceMappingURL=data:application/json;base64,${B64}\nconsole.log(1);\n`), 'main.js'],
      [js(`//# sourceMappingURL=data:text/plain;base64,${B64}\n`), 'main.js'],
      [js(`//# sourceMappingURL=data:application/json;base64,${B64}!!\n`), 'main.js'],
      [js(`//# sourceMappingURL=data:application/json;base64,${Buffer.from('not json').toString('base64')}\n`), 'main.js'],
      [css(`/*# sourceMappingURL=data:application/json;base64,${B64}\n`), 'main.css'],
      [css(), 'main.js'],
      [js(), 'main.css'],
      [js(), 'data.json'],
      [js(), 'index.html'],
    ];
    for (const [bytes, path] of cases) expect(splitInlineSourceMap(bytes, path), `${path}: ${bytes.toString().slice(-40)}`).toBeNull();
  });

  it('only JS and CSS bundles can carry one', () => {
    expect(['main.js', 'a.mjs', 'main.css', 'x/y.JS'].every(mayCarryInlineSourceMap)).toBe(true);
    expect(['index.html', 'a.json', 'a.map', 'a.cjs', 'a.svg'].some(mayCarryInlineSourceMap)).toBe(false);
  });
});
