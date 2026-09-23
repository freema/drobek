/**
 * `task caddy:config` — render the Caddyfile from the environment (M0-07).
 *
 *   node packages/core/dist/cli/caddy-config.js [--out <path>]
 *
 * Without --out the Caddyfile goes to stdout. Configuration errors are listed
 * on stderr with exit code 1 (nothing is written). The file never contains a
 * secret (see caddy.ts), but it is deployment-specific — keep it out of git.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { caddyfileFromEnv } from '../caddy.js';

function parseOut(argv: string[]): string | null {
  const i = argv.indexOf('--out');
  if (i === -1) return null;
  const path = argv[i + 1];
  if (!path || path.startsWith('--')) {
    console.error('caddy-config: --out needs a path');
    process.exit(2);
  }
  return path;
}

const out = parseOut(process.argv.slice(2));
const result = caddyfileFromEnv(process.env);
if (!result.ok) {
  console.error('caddy-config: refusing to generate a Caddyfile:');
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.caddyfile, { mode: 0o644 });
  console.error(`caddy-config: wrote ${out} (TLS mode: ${result.mode})`);
} else {
  process.stdout.write(result.caddyfile);
}
