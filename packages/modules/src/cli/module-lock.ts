/**
 * The installer half that runs where the server runs (NSO-350): `task
 * selfhost:module:add|remove|list` call it inside the drobek image, after
 * npm (in a throwaway node container) has filled a staging prefix — so
 * modules.lock.json is written by the server's own `hashModuleTree()`.
 * The dev stack's `task module:*` run it on the host over `./.modules`.
 *
 *   node node_modules/@drobek/modules/dist/cli/module-lock.js add --staging .staging-<id> --spec <spec>
 *   node node_modules/@drobek/modules/dist/cli/module-lock.js remove --name <name>
 *   node node_modules/@drobek/modules/dist/cli/module-lock.js list
 *
 * Options: --dir (default DROBEK_MODULES_DIR, else /data/modules), --root
 * (the server's directory; default DROBEK_MODULES_ROOT, else the working
 * directory), --modules (the DROBEK_MODULES value to compare with; default
 * the environment's), --compose / --env-name (only for the printed next
 * steps: the compose command and the env file of this stack).
 *
 * Exit 0 on success, 1 on a refusal (the reason on stderr), 2 on bad usage.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_MODULES_DIR } from '../dir-modules.js';
import { MODULES_LOCK_FILE } from '../lock.js';
import { entriesFor, formatModuleTable, installModule, listModules, removeModule, suggestModulesLine } from '../install.js';

const USAGE = `usage: module-lock <add|remove|list> [options]
  add    --staging .staging-<id> --spec <npm spec>   record the module npm installed into <dir>/.staging-<id>
  remove --name <name>                               delete <dir>/<name> and its lockfile entry
  list                                               the installed modules
options: --dir <DROBEK_MODULES_DIR> --root <server dir> --modules <DROBEK_MODULES> --compose <cmd> --env-name <file>`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dir: { type: 'string' },
        root: { type: 'string' },
        modules: { type: 'string' },
        staging: { type: 'string' },
        spec: { type: 'string' },
        name: { type: 'string' },
        compose: { type: 'string', default: 'docker compose' },
        'env-name': { type: 'string', default: '.env.production' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    // db-error-guard: allow — a bad command line (parseArgs), not a database error
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const command = positionals[0];
  const dir = resolve(values.dir ?? (process.env.DROBEK_MODULES_DIR?.trim() || DEFAULT_MODULES_DIR));
  const modules = values.modules ?? process.env.DROBEK_MODULES;
  const compose = values.compose;
  const envFile = values['env-name'];
  const restart = `${compose} up -d --wait drobek`;

  if (command === 'add') {
    if (!values.staging || !values.spec) {
      console.error(USAGE);
      return 2;
    }
    const r = await installModule({
      modulesDir: dir,
      staging: values.staging,
      spec: values.spec,
      serverRoot: resolve(values.root ?? process.env.DROBEK_MODULES_ROOT ?? process.cwd()),
      imageVersion: process.env.DROBEK_VERSION,
    });
    const { line, already } = suggestModulesLine(modules, r.entry, r.package);
    const out = [
      `✓ ${r.package}@${r.version} installed as the module "${r.name}" (contract ${r.contract ?? 'none declared'}) → ${r.prefix}`,
      `  ${MODULES_LOCK_FILE}: ${r.integrity}`,
    ];
    if (r.replaced) out.push(`  replaced ${r.replaced.package}@${r.replaced.version}`);
    if (r.strippedPeers.length > 0) out.push(`  host-provided peers removed from the install: ${r.strippedPeers.join(', ')}`);
    out.push('');
    if (already) {
      out.push(`"${r.entry}" is already in DROBEK_MODULES — restart drobek to load this version:`, `  ${restart}`);
    } else {
      out.push(`Next: enable it in ${envFile} and restart drobek (it applies the module's migrations on start):`, `  ${line}`, `  ${restart}`);
    }
    console.log(out.join('\n'));
    return 0;
  }

  if (command === 'remove') {
    if (!values.name) {
      console.error(USAGE);
      return 2;
    }
    const r = removeModule(dir, values.name);
    const what = r.package ? ` (${r.package}${r.version ? `@${r.version}` : ''})` : '';
    const parts = [r.removedDir ? `${dir}/${r.name}` : null, r.removedLockEntry ? `its ${MODULES_LOCK_FILE} entry` : null].filter(Boolean);
    const out = [`✓ module "${r.name}"${what} removed: ${parts.join(' and ')}`];
    const listed = r.package ? entriesFor(modules, r.package) : [];
    if (listed.length > 0) {
      out.push(
        '',
        `! "${listed.join('", "')}" is still in DROBEK_MODULES — take it out of ${envFile} before drobek restarts (a module it cannot load refuses the start), then:`,
        `  ${restart}`
      );
    }
    out.push(
      '',
      `Its database tables stay: mod_${r.name} / mod_${r.name}_* and the migration journal drizzle.__drizzle_migrations_mod_${r.name}`,
      `(adding the module again finds its data). To drop them for good — after \`task backup\`:`,
      `  ${compose} exec -T postgres psql -U drobek -d drobek -c "SELECT tablename FROM pg_tables WHERE tablename = 'mod_${r.name}' OR tablename LIKE 'mod\\_${r.name}\\_%'"`,
      `  then DROP TABLE each of them and drizzle.__drizzle_migrations_mod_${r.name}.`
    );
    console.log(out.join('\n'));
    return 0;
  }

  if (command === 'list') {
    const rows = listModules(dir);
    if (rows.length === 0) {
      console.log(`no modules installed in ${dir}`);
      return 0;
    }
    console.log(formatModuleTable(rows, modules));
    if (rows.some((r) => r.status !== 'ok')) {
      console.log(`\nchanged / missing / unrecorded: the server refuses to start with such a module in DROBEK_MODULES — add it again (task selfhost:module:add) or remove it.`);
    }
    return 0;
  }

  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // db-error-guard: allow — an installer refusal (package, lockfile, contract), not a database error
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
);
