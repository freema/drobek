/**
 * `node dist/server/rekey.js [--forget-unknown]` — re-wrap every stored secret
 * (upstream and module secrets) under the current DROBEK_MASTER_KEY, the
 * rotation step of docs/SELF-HOSTING.md (`task selfhost:rekey`):
 *
 *   docker compose … run --rm --no-deps -T drobek node dist/server/rekey.js
 *
 * Envelopes of DROBEK_MASTER_KEY_PREVIOUS get their DEK wrapped again under
 * DROBEK_MASTER_KEY; the secret values are never decrypted. Prints the counts
 * per table and exits 0 when every stored secret is under the current key, 1
 * when some are under a key this server does not have (or damaged).
 * `--forget-unknown` deletes the ones under an unknown key. Idempotent, and
 * safe next to a running server. Never prints a key or a secret value.
 */
import { secretsConfigError } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';
import { previousMasterKeyConfigError, rekeyReport, rekeySecrets } from '@drobek/modules';

const configError = secretsConfigError(process.env) ?? previousMasterKeyConfigError(process.env);
if (configError) {
  console.error(configError);
  process.exit(1);
}

const args = process.argv.slice(2);
const unknownArg = args.find((a) => a !== '--forget-unknown');
if (unknownArg !== undefined) {
  console.error(`rekey: unknown argument ${JSON.stringify(unknownArg)} — usage: node dist/server/rekey.js [--forget-unknown]`);
  process.exit(2);
}

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const counts = await rekeySecrets({ env: process.env, forgetUnknown: args.includes('--forget-unknown') });
  const report = rekeyReport(counts, process.env);
  for (const line of report.lines) console.log(line);
  process.exit(report.ok ? 0 : 1);
} catch (err) {
  console.error('rekey: failed —', dbErrorForLog(err));
  process.exit(1);
}
