import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { users, workspaces } from '@drobek/db';
import { createApp, createVersion, crc32, versionZip, zipStream, type ZipEntry } from './index.js';
import { freshDb } from './test/db.js';

/** A minimal ZIP reader: central directory → entries, CRC-checked. */
function readZip(buf: Buffer): Map<string, { bytes: Buffer; method: number; mode: number }> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, { bytes: Buffer; method: number; mode: number }>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    expect(flags & 0x0800).toBe(0x0800);
    if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('bad local header');
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const bytes = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    expect(bytes.length).toBe(size);
    expect(crc32(bytes)).toBe(crc);
    out.set(name, { bytes, method, mode });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

async function collect(gen: AsyncGenerator<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of gen) chunks.push(c);
  return Buffer.concat(chunks);
}

describe('zipStream', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips text (deflated), incompressible bytes (stored), empty files and UTF-8 names', async () => {
    const random = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97 + 13) & 0xff));
    const entries: ZipEntry[] = [
      { name: 'src/main.tsx', bytes: Buffer.from('export const x = 1;\n'.repeat(50)) },
      { name: 'img/raw.bin', bytes: random },
      { name: 'empty.txt', bytes: Buffer.alloc(0) },
      { name: 'docs/čtení.md', bytes: Buffer.from('# ahoj') },
    ];
    const zip = readZip(await collect(zipStream(entries)));
    expect([...zip.keys()]).toEqual(entries.map((e) => e.name));
    for (const e of entries) expect(zip.get(e.name)?.bytes.equals(e.bytes)).toBe(true);
    expect(zip.get('src/main.tsx')?.method).toBe(8);
    expect(zip.get('empty.txt')?.method).toBe(0);
    expect(zip.get('src/main.tsx')?.mode).toBe(0o100644);
  });

  it('an empty archive is just the end record', async () => {
    const buf = await collect(zipStream([]));
    expect(buf.length).toBe(22);
    expect(readZip(buf).size).toBe(0);
  });

  it('refuses duplicate names', async () => {
    const dup = [
      { name: 'a.txt', bytes: Buffer.from('1') },
      { name: 'a.txt', bytes: Buffer.from('2') },
    ];
    await expect(collect(zipStream(dup))).rejects.toThrow(/duplicate/);
  });
});

describe('versionZip', () => {
  it('contains the source AND the built files of exactly that version', async () => {
    const t = await freshDb();
    const [u] = await t.db.insert(users).values({ email: 'z@example.test' }).returning();
    const [w] = await t.db.insert(workspaces).values({ kind: 'personal', slug: 'zipper', name: 'Z' }).returning();
    const actor = { userId: u.id, kind: 'agent' as const };
    const app = await createApp({ workspaceId: w.id, slug: 'zip-app', actor });
    await createVersion(
      app.id,
      [
        { path: 'index.html', content: '<script src="/main.js"></script>' },
        { path: 'src/main.tsx', content: 'console.log(1)' },
        { path: 'main.js', content: 'console.log(1);', kind: 'built' },
      ],
      { actor, compile: { status: 'ok' } }
    );
    await createVersion(app.id, [{ path: 'index.html', content: 'v2' }], { actor });

    const out = await versionZip(app, 1);
    expect(out?.filename).toBe('zip-app-v1.zip');
    const zip = readZip(await collect(out!.stream));
    expect([...zip.keys()].sort()).toEqual([
      'zip-app-v1/built/main.js',
      'zip-app-v1/source/index.html',
      'zip-app-v1/source/src/main.tsx',
    ]);
    expect(zip.get('zip-app-v1/source/src/main.tsx')?.bytes.toString()).toBe('console.log(1)');
    expect(await versionZip(app, 9)).toBeNull();
    await t.pg.close();
  });
});
