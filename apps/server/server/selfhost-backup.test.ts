/**
 * The archive half of the self-host backup scripts (scripts/lib/selfhost.sh,
 * scripts/selfhost-backup-verify.sh, scripts/selfhost-restore.sh) on
 * synthetic archives — bash, tar, gzip and openssl of this machine, no docker:
 * a plain and an encrypted (BACKUP_PASSPHRASE_FILE) archive verify, an
 * encrypted one without the passphrase, with a wrong one, changed or cut
 * short is refused with its own message by verify and by restore (before
 * restore calls docker), and the passphrase never reaches a process argument
 * or the output. The full round trip against real stacks is
 * scripts/selfhost-rehearsal.sh.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PASSPHRASE = 'zQ7-backup-passphrase-for-tests';
const WRONG = 'another-passphrase-of-length';
const PARTS = ['db.dump', 'files.tar', 'assets.tar', 'modules.tar', 'caddy_data.tar'];

let root: string;
let parts: string;
let fakeBin: string;
let argvLog: string;
let passFile: string;
let wrongFile: string;
let envFile: string;

type Run = { status: number | null; out: string };

/** bash with a PATH whose `openssl` logs its arguments and whose `docker` only logs and fails. */
function bash(script: string, args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync('bash', ['-c', script, 'test', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      HOME: root,
      ENV_FILE: envFile,
      ARGV_LOG: argvLog,
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const lib = 'set -euo pipefail; . scripts/lib/selfhost.sh;';

/** The archive of the synthetic parts, written by the lib's pack_backup (encrypted with `keyFile`). */
function pack(name: string, keyFile?: string): string {
  const out = join(root, name);
  const r = bash(`${lib} load_passphrase_file; pack_backup "$1" "$2"`, [parts, out], keyFile ? { BACKUP_PASSPHRASE_FILE: keyFile } : {});
  expect(r.status, r.out).toBe(0);
  return out;
}

const verify = (archive: string, env: Record<string, string> = {}) => bash('exec ./scripts/selfhost-backup-verify.sh', [], { BACKUP: archive, ...env });
const restore = (archive: string, env: Record<string, string> = {}) => bash('exec ./scripts/selfhost-restore.sh', [], { BACKUP: archive, ...env });

/** A copy of `archive` with `bytes` written at `offset` (negative = from the end). */
function damaged(archive: string, name: string, offset: number, bytes = Buffer.from('damaged!')): string {
  const buf = Buffer.from(readFileSync(archive));
  bytes.copy(buf, offset < 0 ? buf.length + offset : offset);
  const out = join(root, name);
  writeFileSync(out, buf);
  return out;
}

const dockerCalls = () => {
  try {
    return readFileSync(join(root, 'docker.log'), 'utf8');
  } catch {
    return '';
  }
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'drobek-backup-test-'));
  parts = join(root, 'parts');
  fakeBin = join(root, 'bin');
  argvLog = join(root, 'openssl-argv.log');
  mkdirSync(parts);
  mkdirSync(fakeBin);
  const realOpenssl = spawnSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(fakeBin, 'openssl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$ARGV_LOG"\nexec ${realOpenssl} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(fakeBin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(root, 'docker.log')}"\nexit 1\n`, { mode: 0o755 });

  const sums: string[] = [];
  const entries: string[] = [];
  for (const p of PARTS) {
    const body = randomBytes(p === 'db.dump' ? 96 * 1024 : 24 * 1024);
    writeFileSync(join(parts, p), body);
    const sha = createHash('sha256').update(body).digest('hex');
    sums.push(`${sha}  ${p}`);
    entries.push(`"${p}": { "bytes": ${body.length}, "sha256": "${sha}" }`);
  }
  writeFileSync(join(parts, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  writeFileSync(
    join(parts, 'manifest.json'),
    [
      '{',
      '  "format": "drobek-backup/1",',
      '  "created_at": "2026-11-16T03:15:00Z",',
      '  "image": "ghcr.io/freema/drobek:test",',
      '  "image_version": "v0.0.0-test",',
      '  "image_git_sha": "abc1234",',
      '  "master_key_fingerprint": "0123456789abcdef",',
      '  "counts": { "apps": 1, "files": 2, "assets": 0, "core_migrations": 3 },',
      `  "parts": {\n    ${entries.join(',\n    ')}\n  }`,
      '}',
      '',
    ].join('\n'),
  );

  passFile = join(root, 'backup.pass');
  wrongFile = join(root, 'wrong.pass');
  writeFileSync(passFile, `${PASSPHRASE}\n`, { mode: 0o600 });
  writeFileSync(wrongFile, `${WRONG}\n`, { mode: 0o600 });
  envFile = join(root, 'env.production');
  writeFileSync(envFile, 'DROBEK_MASTER_KEY=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n', { mode: 0o600 });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a plain archive', () => {
  it('verifies as before, also when BACKUP_PASSPHRASE_FILE is set', () => {
    const plain = pack('drobek-20261116T031500Z.tar.gz');
    expect(readFileSync(plain).subarray(0, 2).toString('hex')).toBe('1f8b');
    const envs: Record<string, string>[] = [{}, { BACKUP_PASSPHRASE_FILE: passFile }];
    for (const env of envs) {
      const r = verify(plain, env);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('is intact — 5 parts');
      expect(r.out).toContain('not encrypted');
    }
  }, 60_000);
});

describe('an encrypted archive (BACKUP_PASSPHRASE_FILE)', () => {
  let enc: string;

  beforeAll(() => {
    enc = pack('drobek-20261116T031600Z.tar.gz.enc', passFile);
  });

  it('is openssl salted ciphertext, mode 600, with nothing of the parts readable', () => {
    const bytes = readFileSync(enc);
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('Salted__');
    expect(bytes.includes('drobek-backup/1')).toBe(false);
    expect(bytes.includes('manifest.json')).toBe(false);
    expect(statSync(enc).mode & 0o777).toBe(0o600);
    expect(spawnSync('tar', ['-tzf', enc]).status).not.toBe(0);
  });

  it('verifies with the passphrase file, from the environment or from ENV_FILE', () => {
    let r = verify(enc, { BACKUP_PASSPHRASE_FILE: passFile });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('is intact — 5 parts');
    expect(r.out).toContain('encrypted (AES-256-CBC, PBKDF2)');

    const withSetting = join(root, 'env.with-passphrase');
    writeFileSync(withSetting, `${readFileSync(envFile, 'utf8')}BACKUP_PASSPHRASE_FILE=${passFile}\n`, { mode: 0o600 });
    r = verify(enc, { ENV_FILE: withSetting });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('is intact');
  }, 60_000);

  it('is refused without the passphrase setting, naming it', () => {
    const r = verify(enc);
    expect(r.status).toBe(1);
    expect(r.out).toContain('is encrypted — set BACKUP_PASSPHRASE_FILE');
    expect(r.out).not.toContain('intact');
  });

  it('is refused with a wrong passphrase', () => {
    const r = verify(enc, { BACKUP_PASSPHRASE_FILE: wrongFile });
    expect(r.status).toBe(1);
    expect(r.out).toContain('wrong passphrase');
    expect(r.out).not.toContain('intact');
  }, 30_000);

  it('is refused when bytes are changed in the middle or at the end, or the file is cut short', () => {
    const size = statSync(enc).size;
    const cases = [
      damaged(enc, 'middle.tar.gz.enc', Math.floor(size / 2)),
      damaged(enc, 'last-block.tar.gz.enc', -8),
      damaged(enc, 'early.tar.gz.enc', 200),
    ];
    const cut = join(root, 'cut.tar.gz.enc');
    writeFileSync(cut, readFileSync(enc).subarray(0, Math.floor(size * 0.7)));
    cases.push(cut);
    for (const archive of cases) {
      const r = verify(archive, { BACKUP_PASSPHRASE_FILE: passFile });
      expect(r.status, `${archive}: ${r.out}`).toBe(1);
      expect(r.out).toContain('damaged');
      expect(r.out).not.toContain('intact');
    }
  }, 120_000);

  it('restore refuses it without the passphrase, with a wrong one or changed — before any docker call', () => {
    rmSync(join(root, 'docker.log'), { force: true });
    let r = restore(enc);
    expect(r.status).toBe(1);
    expect(r.out).toContain('is encrypted — set BACKUP_PASSPHRASE_FILE');
    r = restore(enc, { BACKUP_PASSPHRASE_FILE: wrongFile });
    expect(r.status).toBe(1);
    expect(r.out).toContain('wrong passphrase');
    const size = statSync(enc).size;
    const cut = join(root, 'restore-cut.tar.gz.enc');
    writeFileSync(cut, readFileSync(enc).subarray(0, Math.floor(size * 0.7)));
    for (const archive of [
      damaged(enc, 'restore-early.tar.gz.enc', 200),
      damaged(enc, 'restore-middle.tar.gz.enc', Math.floor(size / 2)),
      damaged(enc, 'restore-last-block.tar.gz.enc', -8),
      cut,
    ]) {
      r = restore(archive, { BACKUP_PASSPHRASE_FILE: passFile });
      expect(r.status, `${archive}: ${r.out}`).toBe(1);
      expect(r.out).toContain('is damaged');
    }
    expect(dockerCalls()).toBe('');
  }, 60_000);

  it('restore decrypts and verifies it before it goes on', () => {
    const r = restore(enc, { BACKUP_PASSPHRASE_FILE: passFile });
    expect(r.out).toContain('verified (decrypted) — created 2026-11-16T03:15:00Z');
  }, 60_000);

  it('never puts the passphrase into an openssl argument or the output', () => {
    const argv = readFileSync(argvLog, 'utf8');
    expect(argv).toContain(`-pass file:${passFile}`);
    expect(argv).toContain('-pbkdf2 -iter 600000 -md sha256');
    expect(argv).not.toContain(PASSPHRASE);
    expect(argv).not.toContain(WRONG);
    const r = verify(enc, { BACKUP_PASSPHRASE_FILE: passFile });
    expect(r.out).not.toContain(PASSPHRASE);
  }, 60_000);
});

describe('the passphrase file', () => {
  it('must exist and hold at least 16 characters; a file others can read is warned about', () => {
    const enc = join(root, 'drobek-20261116T031600Z.tar.gz.enc');
    let r = verify(enc, { BACKUP_PASSPHRASE_FILE: join(root, 'missing.pass') });
    expect(r.status).toBe(1);
    expect(r.out).toContain('no such readable file');
    expect(r.out).toContain('Copy the passphrase file this archive was made with');
    expect(r.out).not.toContain('openssl rand');
    r = bash(`${lib} load_passphrase_file`, [], { BACKUP_PASSPHRASE_FILE: join(root, 'missing.pass') });
    expect(r.status).toBe(1);
    expect(r.out).toContain('openssl rand -base64 32 >');

    const short = join(root, 'short.pass');
    writeFileSync(short, 'tooshort\n', { mode: 0o600 });
    r = verify(enc, { BACKUP_PASSPHRASE_FILE: short });
    expect(r.status).toBe(1);
    expect(r.out).toContain('at least 16 characters');
    expect(r.out).not.toContain('tooshort');

    const shared = join(root, 'shared.pass');
    writeFileSync(shared, `${PASSPHRASE}\n`);
    chmodSync(shared, 0o644);
    r = verify(enc, { BACKUP_PASSPHRASE_FILE: shared });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('can be read by other users');
  }, 60_000);

  it('accepts an openssl whose `enc -help` exits 1 (LibreSSL), refuses one without -pbkdf2', () => {
    const enc = join(root, 'drobek-20261116T031600Z.tar.gz.enc');
    const realOpenssl = spawnSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).stdout.trim();
    const libre = join(root, 'libre-bin');
    const old = join(root, 'old-bin');
    mkdirSync(libre);
    mkdirSync(old);
    const fake = (help: string) =>
      `#!/bin/sh\nif [ "$1 $2" = "enc -help" ]; then\n${help.split('\n').map((l) => `  echo '${l}' >&2`).join('\n')}\n  exit 1\nfi\nexec ${realOpenssl} "$@"\n`;
    writeFileSync(join(libre, 'openssl'), fake(Array.from({ length: 400 }, (_, i) => (i === 3 ? ' -pbkdf2  Use the pbkdf2 key derivation function' : ` -opt${i}  an option`)).join('\n')), { mode: 0o755 });
    writeFileSync(join(old, 'openssl'), fake(' -md digest  Digest to use\n -nosalt  Do not use a salt'), { mode: 0o755 });
    let r = bash('exec ./scripts/selfhost-backup-verify.sh', [], { BACKUP: enc, BACKUP_PASSPHRASE_FILE: passFile, PATH: `${libre}:${process.env.PATH ?? ''}` });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('is intact');
    r = bash('exec ./scripts/selfhost-backup-verify.sh', [], { BACKUP: enc, BACKUP_PASSPHRASE_FILE: passFile, PATH: `${old}:${process.env.PATH ?? ''}` });
    expect(r.status).toBe(1);
    expect(r.out).toContain('has no -pbkdf2');
  }, 60_000);
});

describe('backup_archives', () => {
  it('lists plain and encrypted archives together, oldest first, nothing else', () => {
    const dir = join(root, 'listing');
    mkdirSync(dir);
    for (const f of [
      'drobek-20261102T031500Z.tar.gz.enc',
      'drobek-20261101T031500Z.tar.gz',
      'drobek-20261103T031500Z.tar.gz',
      'drobek-before-upgrade.tar.gz',
      'drobek-20261104T031500Z.tar.gz.enc.partial',
    ]) {
      writeFileSync(join(dir, f), 'x');
    }
    const r = bash(`${lib} backup_archives "$1"`, [dir]);
    expect(r.status, r.out).toBe(0);
    expect(r.out.trim().split('\n').map((l) => l.slice(dir.length + 1))).toEqual([
      'drobek-20261101T031500Z.tar.gz',
      'drobek-20261102T031500Z.tar.gz.enc',
      'drobek-20261103T031500Z.tar.gz',
    ]);
  });
});
