#!/usr/bin/env node
/**
 * npm create drobek-module@latest <name> [-- --module <name>] [--dir <parent>] [--force]
 */
import { relative } from 'node:path';
import { parseTarget, scaffold } from './index.js';

const USAGE = 'usage: npm create drobek-module@latest <name> [-- --module <name>] [--dir <parent>] [--force]';

function main(argv: string[]): number {
  const positional: string[] = [];
  const opts: { module?: string; dir?: string; force: boolean } = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log(USAGE);
      return 0;
    }
    if (a === '--force') opts.force = true;
    else if (a === '--module' || a === '--dir') opts[a === '--module' ? 'module' : 'dir'] = argv[++i];
    else if (a.startsWith('-')) {
      console.error(`unknown option ${a}\n${USAGE}`);
      return 2;
    } else positional.push(a);
  }
  if (positional.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  try {
    const { dir, target, files } = scaffold(parseTarget(positional[0], opts.module), { parent: opts.dir, force: opts.force });
    const rel = relative(process.cwd(), dir) || '.';
    console.log(`Created ${rel}/ — the drobek module "${target.moduleName}" (${target.packageName}, ${files.length} files).

  cd ${rel}
  npm install
  npm test          # the routes through the production pipeline + the SKILL.md gate
  npm run build

Install it on a drobek server (docs/MODULES.md → Writing a module):
  task selfhost:module:add -- <npm spec, tarball or git URL>
  DROBEK_MODULES=…,${target.modulesEntry}`);
    return 0;
  } catch (err) {
    // db-error-guard: allow — a scaffold refusal (bad name, non-empty dir), not a database error
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
