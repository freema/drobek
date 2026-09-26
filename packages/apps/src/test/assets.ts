/** Test helpers for app assets (NSO-358). */

/** `size` bytes that sniff as MP4: an `ftyp` box with the isom brand, then filler. */
export function fakeMp4(size = 4096, fill = 7): Buffer {
  const head = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom\0\0\x02\0isomiso2avc1mp41', 'latin1')]);
  return Buffer.concat([head, Buffer.alloc(size - head.length, fill)]);
}

/** Yield `bytes` in `chunk`-sized pieces (an upload body). */
export async function* chunks(bytes: Buffer, chunk = 1024): AsyncGenerator<Buffer> {
  for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, i + chunk);
}
