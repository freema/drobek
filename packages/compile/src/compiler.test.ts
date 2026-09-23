import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { Compiler, compile } from './index.js';
import type { SourceFiles } from './index.js';

const REACT_TS: Array<[string, string]> = [
  [
    'drobek.json',
    JSON.stringify({
      imports: {
        react: 'https://esm.sh/react@19',
        'react-dom': 'https://esm.sh/react-dom@19',
      },
    }),
  ],
  [
    'index.html',
    '<!doctype html><html><head><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
  ],
  [
    'src/main.tsx',
    [
      "import { createRoot } from 'react-dom/client';",
      "import { App } from './App';",
      "import './app.css';",
      "createRoot(document.getElementById('root')!).render(<App />);",
    ].join('\n'),
  ],
  [
    'src/App.tsx',
    [
      "import { useState } from 'react';",
      "import { greet } from './lib/greet';",
      'export function App() {',
      '  const [n, setN] = useState<number>(0);',
      '  return <button onClick={() => setN(n + 1)}>{greet("drobek")} {n}</button>;',
      '}',
    ].join('\n'),
  ],
  ['src/lib/greet.ts', 'export const greet = (name: string): string => `Hello, ${name}`;'],
  ['src/app.css', 'button { color: rebeccapurple; }'],
];

function app(extra: Array<[string, string | Buffer]> = [], base = REACT_TS): SourceFiles {
  return new Map<string, string | Buffer>([...base, ...extra]);
}

const text = (b: Buffer | undefined) => (b ? b.toString('utf8') : '');

describe('compile — happy path', () => {
  it('bundles TSX and keeps esm.sh imports external', async () => {
    const r = await compile(app());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const js = text(r.outputs.get('main.js'));
    expect(js).toContain('from "https://esm.sh/react@19"');
    expect(js).toContain('from "https://esm.sh/react-dom@19/client"');
    expect(js).toContain('from "https://esm.sh/react@19/jsx-runtime"');
    expect(js).toContain('Hello, ');
    expect(js).toContain('sourceMappingURL=data:');
  });

  it('emits imported CSS as main.css', async () => {
    const r = await compile(app());
    expect(text(r.outputs.get('main.css'))).toContain('rebeccapurple');
  });

  it('maps `drobek` to the platform SDK and supports extra entries', async () => {
    const r = await compile(
      app([
        ['src/admin.tsx', "import { data } from 'drobek';\nconsole.log(data);"],
        [
          'drobek.json',
          JSON.stringify({
            imports: { react: 'https://esm.sh/react@19', 'react-dom': 'https://esm.sh/react-dom@19' },
            entries: ['src/admin.tsx'],
          }),
        ],
      ])
    );
    expect(r.ok).toBe(true);
    expect(text(r.outputs.get('admin.js'))).toContain('from "/__drobek/sdk.js"');
    expect(r.outputs.has('main.js')).toBe(true);
  });

  it('maps `drobek` to the versioned SDK URL it is given (M1-01)', async () => {
    const r = await compile(
      new Map([['src/main.ts', "import { drobek } from 'drobek';\nconsole.log(drobek);"]]),
      { sdkUrl: '/__drobek/sdk.js?v=0123456789abcdef' }
    );
    expect(r.ok).toBe(true);
    expect(text(r.outputs.get('main.js'))).toContain('from "/__drobek/sdk.js?v=0123456789abcdef"');
  });

  describe('drobek/<module> platform sources (M1-02)', () => {
    const GATE = [
      "import { useState } from 'react';",
      "import { drobek } from 'drobek';",
      'export function Gate(props: { label: string }) {',
      '  const [n] = useState(0);',
      '  return <b data-n={n}>{props.label}{String(Boolean(drobek))}</b>;',
      '}',
    ].join('\n');
    const sdk = { sdkUrl: '/__drobek/sdk.js?v=0123456789abcdef', sdkSources: { 'drobek/auth': GATE } };
    const imports = JSON.stringify({
      imports: { react: 'https://esm.sh/react@19.1.0', 'react/jsx-runtime': 'https://esm.sh/react@19.1.0/jsx-runtime' },
    });

    it('compiles the source into the app with the APP\'s import map (one React) and `drobek` → the SDK', async () => {
      const r = await compile(
        new Map([
          ['drobek.json', imports],
          ['src/main.tsx', "import { Gate } from 'drobek/auth';\nimport { useState } from 'react';\nconsole.log(Gate, useState);"],
        ]),
        sdk
      );
      expect(r.ok, JSON.stringify(r.errors)).toBe(true);
      const js = text(r.outputs.get('main.js'));
      expect(js).toContain('function Gate(');
      expect(js).toContain('from "https://esm.sh/react@19.1.0"');
      expect(js).toContain('from "https://esm.sh/react@19.1.0/jsx-runtime"');
      expect(js).toContain('from "/__drobek/sdk.js?v=0123456789abcdef"');
      // The app and the platform source import the very same React URL (one module in the browser).
      const reactUrls = new Set([...js.matchAll(/from "(https:\/\/esm\.sh\/react[^"]*)"/g)].map((m) => m[1]));
      expect(reactUrls).toEqual(new Set(['https://esm.sh/react@19.1.0', 'https://esm.sh/react@19.1.0/jsx-runtime']));
      // The platform source is not an app input.
      expect(r.inputs).toEqual(['src/main.tsx']);
    });

    it('an unknown drobek/<x> is an unresolved import naming the available ones', async () => {
      const r = await compile(new Map([['src/main.ts', "import { x } from 'drobek/data';\nconsole.log(x);"]]), sdk);
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatchObject({ code: 'unresolved_import', specifier: 'drobek/data' });
      expect(r.errors[0].text).toContain('drobek/auth');
    });

    it('without react in the import map the error says what to add', async () => {
      const r = await compile(new Map([['src/main.ts', "import { Gate } from 'drobek/auth';\nconsole.log(Gate);"]]), sdk);
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatchObject({ code: 'unresolved_import', specifier: 'react' });
      expect(r.errors[0].text).toContain('drobek.json imports');
    });

    it('a platform source cannot reach the app files', async () => {
      const r = await compile(
        new Map([
          ['drobek.json', imports],
          ['src/secret.ts', 'export const s = 1;'],
          ['src/main.ts', "import { Gate } from 'drobek/evil';\nconsole.log(Gate);"],
        ]),
        { sdkSources: { 'drobek/evil': "import { s } from '../src/secret';\nexport const Gate = s;" } }
      );
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatchObject({ code: 'unresolved_import', specifier: '../src/secret' });
    });
  });

  it('emits image imports as hashed assets', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const r = await compile(
      new Map<string, string | Buffer>([
        ['src/main.ts', "import logo from './logo.png';\ndocument.body.append(logo);"],
        ['src/logo.png', png],
      ])
    );
    expect(r.ok).toBe(true);
    const asset = [...r.outputs.keys()].find((k) => k.startsWith('assets/logo-'));
    expect(asset).toMatch(/^assets\/logo-[A-Z0-9]+\.png$/);
    expect(text(r.outputs.get('main.js'))).toContain(`"/${asset}"`);
  });

  it('omits the source map for publish builds', async () => {
    const r = await compile(app(), { sourcemap: false });
    expect(text(r.outputs.get('main.js'))).not.toContain('sourceMappingURL');
  });

  it('treats an app without src/main.* as static (nothing to bundle)', async () => {
    const r = await compile(new Map([['index.html', '<h1>hi</h1>']]));
    expect(r).toMatchObject({ ok: true, errors: [] });
    expect(r.outputs.size).toBe(0);
  });

  it('compiles an import cycle without hanging', async () => {
    const r = await compile(
      new Map([
        ['src/main.ts', "import { b } from './b';\nexport const a = () => b;"],
        ['src/b.ts', "import { a } from './main';\nexport const b = () => a;"],
      ])
    );
    expect(r.ok).toBe(true);
  });
});

describe('compile — errors', () => {
  it('reports syntax errors with the exact esbuild location', async () => {
    const broken = 'export const x = (1 + ;\n';
    const r = await compile(new Map([['src/main.ts', broken]]));
    expect(r.ok).toBe(false);
    let expected: { line: number; column: number; text: string } | undefined;
    try {
      transformSync(broken, { loader: 'ts' });
    } catch (e) {
      const m = (e as { errors: Array<{ text: string; location: { line: number; column: number } }> })
        .errors[0];
      expected = { line: m.location.line, column: m.location.column, text: m.text };
    }
    expect(r.errors[0]).toMatchObject({ code: 'build_error', file: 'src/main.ts', ...expected });
  });

  it.each([
    ['../../etc/passwd', 'outside the app'],
    ['/etc/passwd', 'Cannot find'],
    ['fs', 'Unknown import "fs"'],
    ['node:child_process', 'Unknown import'],
    ['//evil.test/x.js', 'scheme-less URL'],
  ])('never reaches the disk: import %s → unresolved_import', async (spec, hint) => {
    const r = await compile(new Map([['src/main.ts', `import x from '${spec}';\nconsole.log(x);`]]));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'unresolved_import', file: 'src/main.ts', line: 1, specifier: spec });
    expect(r.errors[0].text).toContain(hint);
    expect(r.errors[0].text).not.toMatch(/ENOENT|no such file/i);
    // The plugin only ever loaded paths from the in-memory map.
    for (const p of r.inputs) expect(['src/main.ts']).toContain(p);
  });

  it('tells the agent exactly how to add an unknown package', async () => {
    const r = await compile(new Map([['src/main.ts', "import { format } from 'date-fns/format';\nconsole.log(format);"]]));
    expect(r.errors[0].text).toContain('"date-fns": "https://esm.sh/date-fns@<version>"');
    // The specifier travels structured, so a caller can attach a hint (M1-01: firebase → skill_info('data')).
    expect(r.errors[0].specifier).toBe('date-fns/format');
  });

  it('rejects too many files before esbuild starts', async () => {
    const files: SourceFiles = new Map([['src/main.ts', 'export {}']]);
    for (let i = 0; i < 200; i++) files.set(`src/f${i}.ts`, 'export {}');
    let loads = 0;
    const r = await compile(files, {}, { beforeLoad: async () => void loads++ });
    expect(r.errors).toEqual([expect.objectContaining({ code: 'limit_exceeded' })]);
    expect(loads).toBe(0);
  });

  it('rejects 6 MiB total and oversized files before esbuild starts', async () => {
    const files: SourceFiles = new Map([['src/main.ts', 'export {}']]);
    for (let i = 0; i < 12; i++) files.set(`public/big${i}.txt`, 'x'.repeat(500 * 1024));
    files.set('public/huge.txt', 'x'.repeat(600 * 1024));
    let loads = 0;
    const r = await compile(files, {}, { beforeLoad: async () => void loads++ });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('limit_exceeded');
    expect(r.errors[0].text).toContain('in total');
    expect(r.errors.some((e) => e.file === 'public/huge.txt')).toBe(true);
    expect(loads).toBe(0);
  });

  it('refuses secrets in source without echoing them', async () => {
    const key = `sk-ant-api03-${'A1b2C3d4E5'.repeat(4)}`;
    const r = await compile(new Map([['src/main.ts', `// app\nconst k = "${key}";\nexport default k;`]]));
    expect(r.errors).toEqual([
      expect.objectContaining({ code: 'secret_in_source', file: 'src/main.ts', line: 2 }),
    ]);
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it.each([
    ['AWS', 'const id = "AKIAABCDEFGHIJKLMNOP";'],
    ['GitHub', `const t = "ghp_${'a'.repeat(36)}";`],
    ['PEM', '-----BEGIN RSA PRIVATE KEY-----'],
    ['generic', `const apiKey = "${'Zz9'.repeat(8)}";`],
  ])('detects %s credentials', async (_name, line) => {
    const r = await compile(new Map([['src/main.ts', line]]));
    expect(r.errors[0]?.code).toBe('secret_in_source');
  });

  it.each([
    ['../escape.ts', 'invalid_path'],
    ['src/tool.exe', 'invalid_path'],
  ])('rejects the path %s', async (path, code) => {
    const r = await compile(new Map([[path, 'x']]));
    expect(r.errors[0]).toMatchObject({ code });
  });

  it('rejects non-UTF-8 text files', async () => {
    const r = await compile(new Map([['src/main.ts', Buffer.from([0xff, 0xfe, 0x00])]]));
    expect(r.errors[0]).toMatchObject({ code: 'invalid_path', file: 'src/main.ts' });
  });

  it('validates drobek.json', async () => {
    const bad = await compile(new Map([['drobek.json', '{ nope'], ['src/main.ts', '']]));
    expect(bad.errors[0]).toMatchObject({ code: 'invalid_config', file: 'drobek.json' });
    const http = await compile(
      new Map([['drobek.json', '{"imports":{"x":"http://evil.test/x.js"}}'], ['src/main.ts', '']])
    );
    expect(http.errors[0].text).toContain('https://');
  });

  it('caps the import depth (runaway chains fail fast)', async () => {
    const files: SourceFiles = new Map([['src/main.ts', "import './m1';"]]);
    for (let i = 1; i <= 60; i++) files.set(`src/m${i}.ts`, i < 60 ? `import './m${i + 1}';` : '');
    const r = await new Compiler({ maxImportDepth: 50 }).compile(files);
    expect(r.errors[0]).toMatchObject({ code: 'limit_exceeded' });
    expect(r.errors[0].text).toContain('deeper than 50');
  });
});

describe('compile — runtime limits', () => {
  it('stops a hung compile with a timeout error', async () => {
    const c = new Compiler({ timeoutMs: 300 });
    const started = Date.now();
    const r = await c.compile(
      new Map([['src/main.ts', 'export {}']]),
      {},
      { beforeLoad: () => new Promise(() => {}) }
    );
    expect(r.errors).toEqual([expect.objectContaining({ code: 'timeout' })]);
    expect(Date.now() - started).toBeLessThan(2_000);
    // The slot was released: the next compile still works.
    expect((await c.compile(app())).ok).toBe(true);
  });

  it('releases the esbuild context of a timed-out build (no leaked handle)', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = `
      import { Compiler } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
      const r = await new Compiler({ timeoutMs: 200 }).compile(
        new Map([['src/main.ts', 'export {}']]), {}, { beforeLoad: () => new Promise(() => {}) });
      if (r.errors[0]?.code !== 'timeout') process.exit(2);`;
    // The child must exit on its own: a leaked esbuild context keeps it alive.
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5_000 });
  });

  it('runs at most `concurrency` builds at once; the rest queue and succeed', async () => {
    const c = new Compiler({ concurrency: 4 });
    const delay = () => new Promise<void>((r) => setTimeout(r, 30));
    const results = await Promise.all(
      Array.from({ length: 20 }, () => c.compile(app(), {}, { beforeLoad: delay }))
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(c.stats().maxActive).toBe(4);
    expect(c.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('answers `busy` when the queue wait exceeds the limit', async () => {
    const c = new Compiler({ concurrency: 1, queueTimeoutMs: 50, timeoutMs: 1_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = c.compile(app(), {}, { beforeLoad: () => gate });
    const second = await c.compile(app());
    expect(second.errors).toEqual([expect.objectContaining({ code: 'busy' })]);
    release();
    expect((await first).ok).toBe(true);
  });

  it('compiles the react-ts template in under 100 ms (warm)', async () => {
    const c = new Compiler();
    await c.compile(app());
    const times: number[] = [];
    for (let i = 0; i < 5; i++) times.push((await c.compile(app())).durationMs);
    const best = Math.min(...times);
    console.log(`react-ts warm compile: best ${best} ms of [${times.join(', ')}]`);
    expect(best).toBeLessThan(100);
  });
});
