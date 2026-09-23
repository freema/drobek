/**
 * A small streaming ZIP writer (PKZIP 2.0: store / deflate, UTF-8 names, no
 * ZIP64) for the dashboard's "download version" (NSO-288). Written here on
 * `node:zlib` instead of pulling an archiver dependency: a version is at most
 * a few MiB (COMPILE_* limits), so ZIP64, encryption and multi-disk never
 * apply, and the format subset below is ~100 lines that are unit-tested
 * against a reader (zip.test.ts).
 *
 * Streaming: `zipStream` yields each entry's local header + data as soon as
 * the caller's iterable produces it, then the central directory — memory is
 * bounded by the largest single file, not the archive.
 */
import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive (forward slashes, no leading slash). */
  name: string;
  bytes: Buffer;
  /** Modification time (stored as DOS time, UTC). */
  mtime?: Date;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const FLAG_UTF8 = 0x0800;
const VERSION = 20;
/** "made by" = UNIX (3) / spec 2.0 → the external attributes carry a mode. */
const MADE_BY = (3 << 8) | VERSION;
const FILE_MODE = (0o100644 << 16) >>> 0;
const MAX_U32 = 0xffffffff;

interface CentralRecord {
  name: Buffer;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

/** Stream a ZIP archive of `entries` (duplicate names are refused). */
export async function* zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): AsyncGenerator<Buffer> {
  const central: CentralRecord[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for await (const e of entries) {
    const name = e.name.replace(/^\/+/, '');
    if (!name || seen.has(name)) throw new Error(`zip: bad or duplicate entry name ${JSON.stringify(e.name)}`);
    seen.add(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(e.bytes);
    const deflated = e.bytes.length > 0 ? deflateRawSync(e.bytes) : Buffer.alloc(0);
    const useDeflate = deflated.length < e.bytes.length;
    const data = useDeflate ? deflated : e.bytes;
    const method = useDeflate ? 8 : 0;
    if (e.bytes.length >= MAX_U32 || offset + data.length >= MAX_U32) throw new Error('zip: archive too large');
    const { time, date } = dosDateTime(e.mtime ?? new Date());

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(e.bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);

    central.push({ name: nameBytes, method, time, date, crc, compressed: data.length, size: e.bytes.length, offset });
    offset += header.length + nameBytes.length + data.length;
    yield Buffer.concat([header, nameBytes, data]);
  }
  if (central.length > 0xffff) throw new Error('zip: too many entries');

  const parts: Buffer[] = [];
  let cdSize = 0;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(MADE_BY, 4);
    h.writeUInt16LE(VERSION, 6);
    h.writeUInt16LE(FLAG_UTF8, 8);
    h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(c.time, 12);
    h.writeUInt16LE(c.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.compressed, 20);
    h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28);
    // extra len, comment len, disk start, internal attrs = 0
    h.writeUInt32LE(FILE_MODE, 38);
    h.writeUInt32LE(c.offset, 42);
    parts.push(h, c.name);
    cdSize += h.length + c.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  parts.push(end);
  yield Buffer.concat(parts);
}
