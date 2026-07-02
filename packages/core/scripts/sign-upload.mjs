#!/usr/bin/env node
/**
 * Mint a signed upload token (PHY-100) for tests / manual poking.
 *
 *   UPLOAD_SIGNING_SECRET=... node scripts/sign-upload.mjs <sha256> <maxBytes> <ttl-sec>
 *
 * or from the repo root (secret comes from .env via the Taskfile dotenv):
 *
 *   task blob:sign -- <sha256> <maxBytes> <ttl-sec>
 *
 * Prints ONLY the token on stdout (script-friendly); the ready-to-use PUT
 * path goes to stderr.
 */

const [sha256, maxBytesArg, ttlSecArg] = process.argv.slice(2);

function die(msg) {
  console.error(`sign-upload: ${msg}`);
  console.error(
    'usage: UPLOAD_SIGNING_SECRET=... node scripts/sign-upload.mjs <sha256> <maxBytes> <ttl-sec>'
  );
  process.exit(1);
}

if (!sha256 || !maxBytesArg || !ttlSecArg) die('missing arguments');

const secret = process.env.UPLOAD_SIGNING_SECRET;
if (!secret) die('UPLOAD_SIGNING_SECRET is not set');

let mintUploadToken;
try {
  ({ mintUploadToken } = await import('../dist/upload-token.js'));
} catch {
  die(
    'packages/core is not built — run `pnpm --filter @drobek/core build` first'
  );
}

let token;
try {
  token = mintUploadToken(
    {
      sha256,
      maxBytes: Number.parseInt(maxBytesArg, 10),
      ttlSec: Number.parseInt(ttlSecArg, 10),
    },
    secret
  );
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
}

console.error(`PUT /__upload/${token}`);
console.log(token);
