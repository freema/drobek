import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Compiler, TEXT_EXTS, type CompileResult } from '@drobek/compile';
import { buildSdk, type SdkBundle } from '@drobek/modules';
import { BUILTIN_MODULES, REPO_ROOT } from './skills.js';

/**
 * The `port-app` skill's fixtures: `tests-eval/fixtures/lovable-export` is a
 * Lovable-shaped export (Vite + React + TypeScript + Tailwind v3 + shadcn/ui
 * with the `@/` alias, react-router-dom, a Supabase client), and
 * `lovable-ported` is that project ported by the skill's procedure — what
 * scenario e of the agent eval expects and port-app.spec.ts writes over MCP.
 * Here drobek's own compiler proves the port compiles, loads every package
 * from esm.sh (the only script origin of the app CSP) and keeps one React.
 */
const FIXTURES = join(REPO_ROOT, 'tests-eval', 'fixtures');
const EXPORT = join(FIXTURES, 'lovable-export');
const PORTED = join(FIXTURES, 'lovable-ported');

function walk(root: string, dir = root, out = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(root, p, out);
    else out.set(relative(root, p).split('\\').join('/'), readFileSync(p));
  }
  return out;
}

const textOf = (files: Map<string, Buffer>) =>
  new Map([...files].filter(([p]) => TEXT_EXTS.has(extname(p))).map(([p, b]) => [p, b.toString('utf8')] as [string, string]));

const exported = walk(EXPORT);
const ported = textOf(walk(PORTED));
const importMap = JSON.parse(ported.get('drobek.json')!) as { imports: Record<string, string>; paths: Record<string, string[]> };

let sdk: SdkBundle;
let result: CompileResult;
beforeAll(async () => {
  sdk = await buildSdk(BUILTIN_MODULES);
  result = await new Compiler().compile(ported, {
    sdkUrl: sdk.url,
    sdkSources: sdk.inline,
    beaconUrl: sdk.beacon.url,
    servedPaths: ['/logo.png'],
  });
});

describe('port-app fixture: the Lovable-shaped export', () => {
  it('has what a Lovable export has: @/ imports, a Supabase client, Vite env, Tailwind v3 directives, a third-party script, public/ files', () => {
    expect(exported.get('src/pages/Index.tsx')!.toString()).toContain('from "@/integrations/supabase/client"');
    expect(exported.get('src/integrations/supabase/client.ts')!.toString()).toContain("from '@supabase/supabase-js'");
    expect(exported.get('src/integrations/supabase/client.ts')!.toString()).toContain('import.meta.env.VITE_SUPABASE_URL');
    expect(exported.get('src/index.css')!.toString()).toContain('@tailwind base;');
    expect(exported.get('src/index.css')!.toString()).toContain('@apply bg-background text-foreground;');
    expect(exported.get('index.html')!.toString()).toContain('https://cdn.gpteng.co/gptengineer.js');
    expect(exported.get('index.html')!.toString()).toContain('src="/src/main.tsx"');
    expect(exported.get('tsconfig.json')!.toString()).toContain('"@/*": ["./src/*"]');
    expect([...exported.keys()].filter((p) => p.startsWith('public/')).sort()).toEqual(['public/favicon.svg', 'public/logo.png', 'public/robots.txt']);
    expect(exported.get('public/logo.png')!.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('written as it is, it does not compile: no packages are mapped and the @/ alias is undefined', async () => {
    const raw = textOf(new Map([...exported].filter(([p]) => p.startsWith('src/') && !p.endsWith('.d.ts'))));
    raw.set('index.html', exported.get('index.html')!.toString());
    const r = await new Compiler().compile(raw, { sdkUrl: sdk.url, sdkSources: sdk.inline });
    expect(r.ok).toBe(false);
    const alias = r.errors.find((e) => e.specifier === '@/components/ui/sonner');
    expect(alias?.code).toBe('unresolved_import');
    expect(alias?.text).toContain('"paths": { "@/*": ["src/*"] }');
    expect(r.errors.some((e) => e.specifier === 'react-router-dom')).toBe(true);
  });
});

describe('port-app fixture: the port', () => {
  it('compiles with drobek\'s compiler, without a warning (every reference exists, nothing the CSP blocks)', () => {
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.inputs).toEqual(expect.arrayContaining(['src/components/ui/button.tsx', 'src/lib/utils.ts', 'src/pages/Index.tsx', 'src/pages/NotFound.tsx']));
    expect([...result.outputs.keys()].sort()).toEqual(['main.css', 'main.js']);
  });

  it('keeps the components, the router shell and the utils byte for byte: @/ resolves through drobek.json paths', () => {
    expect(importMap.paths).toEqual({ '@/*': ['src/*'] });
    const unchanged = ['src/main.tsx', 'src/App.tsx', 'src/lib/utils.ts', 'src/pages/NotFound.tsx', ...[...exported.keys()].filter((p) => p.startsWith('src/components/ui/'))];
    for (const p of unchanged) expect(ported.get(p), p).toBe(exported.get(p)!.toString());
    expect(ported.get('favicon.svg')).toBe(exported.get('public/favicon.svg')!.toString());
    expect(ported.get('robots.txt')).toBe(exported.get('public/robots.txt')!.toString());
    expect([...ported.keys()].some((p) => p.startsWith('src/integrations/') || p.startsWith('public/'))).toBe(false);
  });

  it('replaces the Supabase client with drobek.data and the Vite env with a constant', () => {
    const index = ported.get('src/pages/Index.tsx')!;
    expect(index).toContain('import { drobek } from "drobek";');
    expect(index).toContain('drobek.data.collection');
    for (const p of ported.keys()) {
      expect(ported.get(p), p).not.toMatch(/supabase|import\.meta\.env/);
    }
  });

  it('loads every package from esm.sh and every script from the app or esm.sh (the app CSP script-src)', () => {
    const js = result.outputs.get('main.js')!.toString('utf8');
    const external = [...js.matchAll(/(?:from|import)\s*"(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(external.length).toBeGreaterThanOrEqual(10);
    expect(external.filter((u) => !u.startsWith('https://esm.sh/'))).toEqual([]);
    const html = ported.get('index.html')!;
    const scripts = [...html.matchAll(/<script\b([^>]*)\bsrc="([^"]+)"/g)].map((m) => [m[2], /type="module"/.test(m[1])] as const);
    expect(scripts).toEqual([
      ['https://esm.sh/@tailwindcss/browser@4.1.11', true],
      ['/main.js', true],
    ]);
    expect(html).not.toContain('gptengineer');
    expect(html).toContain('<style type="text/tailwindcss">');
    expect(html).toContain('@apply bg-background text-foreground;');
    expect(ported.get('src/index.css')).not.toMatch(/@tailwind|@apply/);
  });

  it('pins one React: react-dom and every package that imports React carry ?deps= on the same version', () => {
    const react = /^https:\/\/esm\.sh\/react@([\d.]+)$/.exec(importMap.imports.react)?.[1];
    expect(react).toBe('18.3.1');
    const usesReact = ['react-dom', 'react-dom/client', 'react-router-dom', '@tanstack/react-query', '@radix-ui/react-slot', '@radix-ui/react-label', 'lucide-react', 'sonner', 'next-themes'];
    for (const name of usesReact) {
      const url = new URL(importMap.imports[name]);
      expect(url.searchParams.get('deps')?.split(',')[0], name).toBe(`react@${react}`);
      expect(url.searchParams.has('external'), name).toBe(false);
    }
    for (const url of Object.values(importMap.imports)) expect(url, url).toMatch(/^https:\/\/esm\.sh\/(@[\w-]+\/)?[\w.-]+@\d+\.\d+\.\d+(\/[\w-]+)?(\?deps=[\w@.,/-]+)?$/);
  });
});
