import { describe, expect, it } from 'vitest';
import { typecheckApp, type TypecheckSdk } from './check.js';

const SDK: TypecheckSdk = {
  dts: [
    'export interface Drobek { readonly data: { list(collection: string): Promise<unknown[]> } }',
    'export declare const drobek: Drobek;',
    'export default drobek;',
  ].join('\n'),
  inline: {
    auth: "import type { JSX, ReactNode } from 'react';\nexport function LoginGate(props: { children: ReactNode }): JSX.Element;",
  },
};

const REACT_MAIN = [
  "import { StrictMode, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import './styles.css';",
  '',
  'function App() {',
  '  const [count, setCount] = useState(0);',
  '  return <button onClick={() => setCount((n) => n + 1)}>Clicked {count} times</button>;',
  '}',
  '',
  "createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);",
  '',
].join('\n');

describe('typecheckApp', () => {
  it('passes the react-ts template shape (React, react-dom, CSS import)', async () => {
    const out = await typecheckApp(new Map([['src/main.tsx', REACT_MAIN], ['src/styles.css', 'body{}']]), SDK, 50);
    expect(out).toEqual({ findings: [], total: 0 });
  });

  it('reports a type error with file, line and the TS code', async () => {
    const src = REACT_MAIN.replace('useState(0)', "useState<number>('zero')");
    const out = await typecheckApp(new Map([['src/main.tsx', src]]), SDK, 50);
    expect(out.total).toBe(1);
    expect(out.findings[0]).toMatchObject({ file: 'src/main.tsx', line: 6 });
    expect(out.findings[0].message).toMatch(/^TS2345: /);
  });

  it('checks calls against the server SDK declarations (drobek and drobek/<module>)', async () => {
    const files = new Map([
      [
        'src/main.tsx',
        [
          "import { drobek } from 'drobek';",
          "import { LoginGate } from 'drobek/auth';",
          "await drobek.data.lst('todos');",
          'export const gate = <LoginGate>hi</LoginGate>;',
          '',
        ].join('\n'),
      ],
    ]);
    const out = await typecheckApp(files, SDK, 50);
    expect(out.findings.map((f) => [f.line, f.message.slice(0, 7)])).toEqual([[3, 'TS2551:']]);
  });

  it('treats an import-map package without types as untyped, and asset imports as modules', async () => {
    const files = new Map([
      [
        'src/main.ts',
        [
          "import confetti from 'canvas-confetti';",
          "import logo from './logo.svg';",
          "import data from './data.json';",
          "import { helper } from './util';",
          'confetti({ particleCount: 3 });',
          'const n: number = data.count;',
          'console.log(logo.toUpperCase(), n, helper(2));',
          '',
        ].join('\n'),
      ],
      ['src/util.ts', 'export function helper(n: number): string { return String(n); }\n'],
      ['src/data.json', '{ "count": 3 }'],
    ]);
    expect(await typecheckApp(files, SDK, 50)).toEqual({ findings: [], total: 0 });
  });

  it('reports errors across files, ordered by file and line, capped at maxFindings', async () => {
    const files = new Map([
      ['src/b.ts', 'export const b: number = "x";\nexport const c: string = 1;\n'],
      ['src/a.ts', 'import { b } from "./b";\nexport const a: string = b;\n'],
    ]);
    const out = await typecheckApp(files, SDK, 2);
    expect(out.total).toBe(3);
    expect(out.findings.map((f) => `${f.file}:${f.line}`)).toEqual(['src/a.ts:2', 'src/b.ts:1']);
  });

  it('skips a JS-only app (checkJs off)', async () => {
    const files = new Map([['src/main.js', 'const x = 1; x.foo.bar();\n']]);
    expect(await typecheckApp(files, SDK, 50)).toEqual({ findings: [], total: 0 });
  });

  it('never reports on the library or SDK declarations themselves', async () => {
    const out = await typecheckApp(new Map([['src/main.ts', 'export {};\n']]), { dts: 'export declare const x: Missing;', inline: {} }, 50);
    expect(out.total).toBe(0);
  });
});
