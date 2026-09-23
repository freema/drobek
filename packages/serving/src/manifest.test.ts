import { describe, expect, it } from 'vitest';
import { isUnservedSource, servedManifest, type StoredFile } from './manifest.js';

const f = (path: string, kind: 'source' | 'built', sha = path): StoredFile => ({ path, sha256: sha, size: 1, kind });

describe('servedManifest', () => {
  it('serves built output + non-TS sources; built wins on the same path', () => {
    const m = servedManifest([
      f('index.html', 'source'),
      f('src/main.tsx', 'source'),
      f('src/util.ts', 'source'),
      f('src/legacy.jsx', 'source'),
      f('src/styles.css', 'source'),
      f('drobek.json', 'source'),
      f('logo.svg', 'source'),
      f('main.js', 'source', 'hand-written'),
      f('main.js', 'built', 'compiled'),
      f('main.css', 'built'),
    ]);
    expect([...m.keys()].sort()).toEqual(['index.html', 'logo.svg', 'main.css', 'main.js', 'src/styles.css']);
    expect(m.get('main.js')?.sha256).toBe('compiled');
  });

  it('never serves TypeScript/JSX sources or drobek.json', () => {
    for (const p of ['a.ts', 'a.tsx', 'a.jsx', 'a.mts', 'a.cts', 'types.d.ts', 'drobek.json', 'SRC/X.TSX']) {
      expect(isUnservedSource(p), p).toBe(true);
    }
    for (const p of ['a.js', 'a.css', 'index.html', 'data.json', 'nested/drobek.json']) {
      expect(isUnservedSource(p), p).toBe(false);
    }
  });
});
