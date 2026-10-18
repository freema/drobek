/**
 * Re-encoding untrusted images: the type comes from the magic bytes, the
 * output is a fresh WebP / JPEG within the size and dimension limits, and no
 * metadata of the upload survives.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MCP_IMAGE_MAX_BYTES,
  DEFAULT_SCREENSHOT_MAX_BYTES,
  imageLimits,
  reencodeForMcp,
  reencodeImage,
  reencodeScreenshot,
  sniffImageType,
} from './image.server.js';

function noise(width: number, height: number): Buffer {
  const px = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = seed >> 16;
  }
  return px;
}

async function png(width: number, height: number, opts: { noisy?: boolean } = {}): Promise<Buffer> {
  const img = opts.noisy
    ? sharp(noise(width, height), { raw: { width, height, channels: 3 } })
    : sharp({ create: { width, height, channels: 3, background: '#3366cc' } });
  return img.png().toBuffer();
}

describe('sniffImageType', () => {
  it('knows PNG, JPEG and WebP by their first bytes only', async () => {
    expect(sniffImageType(await png(4, 4))).toBe('png');
    expect(sniffImageType(await sharp(await png(4, 4)).jpeg().toBuffer())).toBe('jpeg');
    expect(sniffImageType(await sharp(await png(4, 4)).webp().toBuffer())).toBe('webp');
    expect(sniffImageType(await sharp(await png(4, 4)).gif().toBuffer())).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('RIFF0000WAVE'))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});

describe('reencodeImage', () => {
  it('refuses what is not a PNG, JPEG or WebP, whatever it claims to be', async () => {
    const gif = await sharp(await png(4, 4)).gif().toBuffer();
    await expect(reencodeScreenshot(gif)).rejects.toMatchObject({ code: 'invalid_image' });
    await expect(reencodeScreenshot(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>'))).rejects.toMatchObject({
      code: 'invalid_image',
    });
  });

  it('refuses a damaged image and one whose magic bytes lie about its type', async () => {
    const real = await png(64, 64);
    await expect(reencodeScreenshot(real.subarray(0, 40))).rejects.toMatchObject({ code: 'invalid_image' });
    const jpeg = await sharp(real).jpeg().toBuffer();
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), jpeg]);
    await expect(reencodeScreenshot(fake)).rejects.toMatchObject({ code: 'invalid_image' });
  });

  it('refuses an image that declares too many pixels before decoding it', async () => {
    const huge = await sharp({ create: { width: 9000, height: 5000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
    await expect(reencodeScreenshot(huge)).rejects.toMatchObject({ code: 'invalid_image' });
  });

  it('writes a WebP with the longer side capped, never enlarging a small image', async () => {
    const big = await reencodeScreenshot(await png(3200, 1000));
    expect(big).toMatchObject({ format: 'webp', mimeType: 'image/webp', width: 1600, height: 500 });
    expect(sniffImageType(big.bytes)).toBe('webp');
    const meta = await sharp(big.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 1600, 500]);
    const small = await reencodeScreenshot(await png(300, 200));
    expect([small.width, small.height]).toEqual([300, 200]);
  });

  it('drops the metadata of the upload and applies its orientation', async () => {
    const tagged = await sharp(await png(60, 30))
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'gps-and-name', Artist: 'Someone' } } })
      .toBuffer();
    const before = await sharp(tagged).metadata();
    expect(before.exif).toBeDefined();
    const out = await reencodeScreenshot(tagged);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect([out.width, out.height]).toEqual([30, 60]);
    expect(out.bytes.includes(Buffer.from('gps-and-name'))).toBe(false);
  });

  it('steps the quality and the size down until the output fits', async () => {
    const input = await png(1200, 900, { noisy: true });
    const out = await reencodeImage(input, { maxSide: 1600, maxBytes: 60 * 1024, format: 'webp' });
    expect(out.bytes.length).toBeLessThanOrEqual(60 * 1024);
    await expect(reencodeImage(input, { maxSide: 1600, maxBytes: 200, format: 'webp' })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('an MCP image is a JPEG within MCP_IMAGE_MAX_BYTES and 1280 px', async () => {
    const stored = await reencodeScreenshot(await png(1600, 1000, { noisy: true }));
    const img = await reencodeForMcp(stored.bytes, { screenshotMaxBytes: DEFAULT_SCREENSHOT_MAX_BYTES, mcpImageMaxBytes: 100 * 1024 });
    expect(img.mimeType).toBe('image/jpeg');
    expect(sniffImageType(img.bytes)).toBe('jpeg');
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1280);
    expect(img.bytes.length).toBeLessThanOrEqual(100 * 1024);
  });
});

describe('imageLimits', () => {
  it('reads SCREENSHOT_MAX_BYTES and MCP_IMAGE_MAX_BYTES with production defaults', () => {
    expect(imageLimits({})).toEqual({ screenshotMaxBytes: DEFAULT_SCREENSHOT_MAX_BYTES, mcpImageMaxBytes: DEFAULT_MCP_IMAGE_MAX_BYTES });
    expect(DEFAULT_SCREENSHOT_MAX_BYTES).toBe(1024 * 1024);
    expect(DEFAULT_MCP_IMAGE_MAX_BYTES).toBe(400 * 1024);
    expect(imageLimits({ SCREENSHOT_MAX_BYTES: '2048', MCP_IMAGE_MAX_BYTES: '0' })).toEqual({
      screenshotMaxBytes: 2048,
      mcpImageMaxBytes: DEFAULT_MCP_IMAGE_MAX_BYTES,
    });
  });
});
