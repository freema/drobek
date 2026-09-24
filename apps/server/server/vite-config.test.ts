import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';

/**
 * NSO-314 regression guard. The dev client dep optimizer must stay explicit
 * (`noDiscovery`): with discovery on, React Router's dev SSR render registers
 * server-only deps with the client optimizer lazily, and on a cold cache the
 * re-optimization's forced full page reload wiped the first sign-in of a run.
 * Explicit mode only works while the browser imports no npm package outside
 * `include` (+ the React Router plugin's react / react-dom / react-router),
 * so the second test walks the client-side sources for bare imports.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// What the React Router plugin itself adds to the client optimizer's include.
const PLUGIN_INCLUDED = ['react', 'react-dom', 'react-router'];

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const isClientSource = (p: string) =>
  /\.tsx?$/.test(p) && !/\.server\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith('.d.ts');

// Value imports and re-exports (`import type` / `export type` are erased).
const IMPORT_RE = /^(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function specifiers(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT_RE)].map((m) => m[1]);
}

function resolveRelative(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec).replace(/\.js$/, '');
  for (const cand of [`${base}.tsx`, `${base}.ts`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** npm packages reachable from the client halves: every non-server .tsx file plus its relative imports. */
function clientNpmImports(): Map<string, string> {
  const roots = [join(repoRoot, 'apps/server/app')];
  for (const top of ['packages', 'modules']) {
    for (const name of readdirSync(join(repoRoot, top))) {
      const src = join(repoRoot, top, name, 'src');
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        // package without src/
      }
    }
  }
  const queue = roots.flatMap((r) => walk(r, [])).filter((p) => p.endsWith('.tsx') && isClientSource(p));
  const seen = new Set<string>();
  const found = new Map<string, string>();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(file)) {
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec);
        if (target && isClientSource(target)) queue.push(target);
        continue;
      }
      if (spec.startsWith('node:') || spec.startsWith('~/') || spec.startsWith('virtual:')) continue;
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      // Workspace packages are linked source, never pre-bundled.
      if (pkg.startsWith('@drobek/') || pkg.startsWith('drobek-module-')) continue;
      if (!found.has(pkg)) found.set(pkg, file.slice(repoRoot.length + 1));
    }
  }
  return found;
}

describe('dev client dep optimizer (NSO-314)', () => {
  it('is explicit: no runtime dependency discovery', () => {
    expect(viteConfig.optimizeDeps?.noDiscovery).toBe(true);
  });

  it('covers every npm package the client-side sources import', () => {
    const included = new Set(
      [...PLUGIN_INCLUDED, ...(viteConfig.optimizeDeps?.include ?? [])].map((s) =>
        s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]
      )
    );
    const missing = [...clientNpmImports()].filter(([pkg]) => !included.has(pkg));
    expect(
      missing,
      'add these browser-side npm packages to optimizeDeps.include in apps/server/vite.config.ts'
    ).toEqual([]);
  });
});
