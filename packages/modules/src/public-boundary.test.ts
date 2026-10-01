/**
 * The public contract (public.ts, the npm package's `.`) stays apart from the
 * runtime: its import graph reaches only the contract files, and the
 * example modules and the create-drobek-module template use nothing else of
 * `@drobek/modules` than the contract and `@drobek/modules/testing`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SRC, '../../..');

const CONTRACT_FILES = ['auth-provider.ts', 'contract.ts', 'email-transport-slot.ts', 'error-reporter-slot.ts', 'errors.ts', 'public.ts', 'rules.ts'];
const VALUE_PACKAGES = ['zod', '@drobek/core', '@drobek/email'];
const TYPE_PACKAGES = [...VALUE_PACKAGES, '@drobek/db', '@drobek/sdk'];

interface Import {
  spec: string;
  typeOnly: boolean;
  names: string[];
}

function importsOf(file: string): Import[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: Import[] = [];
  for (const st of sf.statements) {
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      let typeOnly = false;
      let names: string[] = [];
      if (ts.isImportDeclaration(st)) {
        const clause = st.importClause;
        const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
        typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings) && named.every((e) => e.isTypeOnly)));
        names = named.map((e) => (e.propertyName ?? e.name).text);
        if (clause?.name) names.push('default');
      } else {
        const named = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : [];
        typeOnly = st.isTypeOnly || (named.length > 0 && named.every((e) => e.isTypeOnly));
        names = named.map((e) => e.name.text);
      }
      out.push({ spec: st.moduleSpecifier.text, typeOnly, names });
    }
  }
  return out;
}

const packageOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);

function contractGraph() {
  const files = new Set<string>();
  const bare: (Import & { from: string })[] = [];
  const queue = [join(SRC, 'public.ts')];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const imp of importsOf(file)) {
      if (imp.spec.startsWith('.')) queue.push(resolve(dirname(file), imp.spec.replace(/\.js$/, '.ts')));
      else if (!imp.spec.startsWith('node:')) bare.push({ ...imp, from: relative(SRC, file) });
    }
  }
  return { files: [...files].map((f) => relative(SRC, f)).sort(), bare };
}

describe('the public contract', () => {
  const graph = contractGraph();

  it('reaches only the contract files — never the runtime, registry or loader', () => {
    expect(graph.files).toEqual(CONTRACT_FILES);
  });

  it('imports values only from zod, @drobek/core and @drobek/email; types also from @drobek/db and @drobek/sdk', () => {
    for (const imp of graph.bare) {
      const allowed = imp.typeOnly ? TYPE_PACKAGES : VALUE_PACKAGES;
      expect(allowed, `${imp.from} imports ${imp.typeOnly ? 'types' : 'values'} from ${imp.spec}`).toContain(packageOf(imp.spec));
    }
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n === 'dist') return [];
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('the example modules and the scaffold template', () => {
  const contract = new Set(importsOf(join(SRC, 'public.ts')).flatMap((i) => i.names));
  const dirs = [
    ...readdirSync(join(ROOT, 'examples')).map((n) => join(ROOT, 'examples', n, 'src')),
    join(ROOT, 'packages/create-drobek-module/template/src'),
  ];

  it.each(dirs.map((d) => [relative(ROOT, d), d]))('%s imports only the contract and @drobek/modules/testing', (_, dir) => {
    for (const file of sources(dir)) {
      for (const imp of importsOf(file).filter((i) => packageOf(i.spec) === '@drobek/modules')) {
        const where = `${relative(ROOT, file)}: ${imp.spec}`;
        expect(['@drobek/modules', '@drobek/modules/testing'], where).toContain(imp.spec);
        if (imp.spec === '@drobek/modules') for (const n of imp.names) expect(contract.has(n), `${where} → ${n}`).toBe(true);
      }
    }
  });
});
