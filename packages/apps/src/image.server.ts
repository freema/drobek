/**
 * Images people hand drobek (a screenshot on a feedback note) — decoded and
 * re-encoded in-process with sharp (libvips); the original bytes are never
 * stored or served.
 *
 * The input is untrusted: its type is sniffed from the magic bytes (PNG, JPEG
 * or WebP only, whatever the file name or Content-Type said), the decoded
 * format must match the sniffed one, the pixel count is capped before a pixel
 * is decoded (IMAGE_INPUT_MAX_PIXELS), only the first frame of an animation is
 * read, and every libvips loader except the PNG / JPEG / WebP buffer loaders is
 * blocked for the whole process. The output is a fresh WebP or JPEG of the
 * decoded pixels: the EXIF orientation is applied, then all metadata (EXIF,
 * XMP, ICC, text chunks) is left behind; its longer side and its size are
 * capped by the caller, stepping the quality and then the dimensions down
 * until it fits.
 *
 *   SCREENSHOT_MAX_BYTES  the largest screenshot a note accepts (the upload)
 *                         and stores (the re-encoded WebP); default 1 MiB
 *   MCP_IMAGE_MAX_BYTES   the largest JPEG an MCP tool returns as an image
 *                         content block; default 400 KiB
 */
import type { Sharp, SharpOptions } from 'sharp';
import { AppsError } from './errors.js';

export type ImageInputType = 'png' | 'jpeg' | 'webp';
export type ImageOutputFormat = 'webp' | 'jpeg';

export const DEFAULT_SCREENSHOT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_MCP_IMAGE_MAX_BYTES = 400 * 1024;
/** The longer side of a stored screenshot, in pixels. */
export const SCREENSHOT_MAX_SIDE = 1600;
/** The longer side of an image an MCP tool returns, in pixels. */
export const MCP_IMAGE_MAX_SIDE = 1280;
/** The most pixels an input may declare; a larger one is refused before it is decoded. */
export const IMAGE_INPUT_MAX_PIXELS = 40_000_000;
/** The shortest longer side the size steps go down to before giving up. */
const MIN_SIDE = 320;
const QUALITIES = [82, 70, 58, 46, 36] as const;

export const IMAGE_MIME_TYPES: Record<ImageInputType, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface ImageLimits {
  /** SCREENSHOT_MAX_BYTES */
  screenshotMaxBytes: number;
  /** MCP_IMAGE_MAX_BYTES */
  mcpImageMaxBytes: number;
}

export function imageLimits(env: NodeJS.ProcessEnv = process.env): ImageLimits {
  return {
    screenshotMaxBytes: positiveIntEnv(env.SCREENSHOT_MAX_BYTES, DEFAULT_SCREENSHOT_MAX_BYTES),
    mcpImageMaxBytes: positiveIntEnv(env.MCP_IMAGE_MAX_BYTES, DEFAULT_MCP_IMAGE_MAX_BYTES),
  };
}

/** The image type from the magic bytes, or null when the bytes are not a PNG, JPEG or WebP. */
export function sniffImageType(bytes: Uint8Array): ImageInputType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

type SharpFactory = (input?: Buffer | Uint8Array, options?: SharpOptions) => Sharp;

let loaded: Promise<SharpFactory> | null = null;

/** sharp, loaded on first use with every loader but the PNG / JPEG / WebP buffer loaders blocked and its cache off. */
function sharpLib(): Promise<SharpFactory> {
  loaded ??= import('sharp').then(({ default: sharp }) => {
    sharp.block({ operation: ['VipsForeignLoad'] });
    sharp.unblock({ operation: ['VipsForeignLoadPngBuffer', 'VipsForeignLoadJpegBuffer', 'VipsForeignLoadWebpBuffer'] });
    sharp.cache(false);
    return sharp as unknown as SharpFactory;
  });
  return loaded;
}

export interface EncodedImage {
  bytes: Buffer;
  width: number;
  height: number;
  format: ImageOutputFormat;
  mimeType: 'image/webp' | 'image/jpeg';
}

export interface ReencodeOptions {
  /** The longer side of the output, at most (smaller inputs are never enlarged). */
  maxSide: number;
  /** The output's size, at most. */
  maxBytes: number;
  format: ImageOutputFormat;
}

function invalid(message: string): AppsError {
  return new AppsError('invalid_image', message);
}

/**
 * Decode an untrusted PNG / JPEG / WebP and encode its pixels afresh as
 * `format` within `maxSide` and `maxBytes`. Refuses `invalid_image` for bytes
 * that are not one of the three types, do not decode, or declare more than
 * IMAGE_INPUT_MAX_PIXELS pixels; `too_large` when even the smallest step does
 * not fit `maxBytes`.
 */
export async function reencodeImage(input: Uint8Array, opts: ReencodeOptions): Promise<EncodedImage> {
  const type = sniffImageType(input);
  if (!type) throw invalid('The screenshot must be a PNG, JPEG or WebP image.');
  const sharp = await sharpLib();
  const source = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const readOpts: SharpOptions = { limitInputPixels: IMAGE_INPUT_MAX_PIXELS, failOn: 'error', animated: false, sequentialRead: true };
  let decoded: { data: Buffer; info: { width: number; height: number; channels: 1 | 2 | 3 | 4 } };
  try {
    const meta = await sharp(source, readOpts).metadata();
    if (meta.format !== type) throw invalid('The screenshot is not the image its first bytes say it is.');
    if (!meta.width || !meta.height) throw invalid('The screenshot has no size.');
    if (meta.width * meta.height > IMAGE_INPUT_MAX_PIXELS) throw invalid('The screenshot has too many pixels.');
    decoded = await sharp(source, readOpts)
      .autoOrient()
      .resize({ width: opts.maxSide, height: opts.maxSide, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    if (err instanceof AppsError) throw err;
    throw invalid('The screenshot could not be read as an image — it may be damaged, or too large in pixels.');
  }
  const { data, info } = decoded;
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
  let side = Math.max(info.width, info.height);
  for (;;) {
    for (const quality of QUALITIES) {
      let p = sharp(data, raw);
      if (side < Math.max(info.width, info.height)) p = p.resize({ width: side, height: side, fit: 'inside' });
      p = opts.format === 'jpeg' ? p.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }) : p.webp({ quality, effort: 4 });
      const out = await p.toBuffer({ resolveWithObject: true });
      if (out.info.size <= opts.maxBytes) {
        return {
          bytes: out.data,
          width: out.info.width,
          height: out.info.height,
          format: opts.format,
          mimeType: opts.format === 'jpeg' ? 'image/jpeg' : 'image/webp',
        };
      }
    }
    if (side <= MIN_SIDE) break;
    side = Math.max(MIN_SIDE, Math.floor(side * 0.75));
  }
  throw new AppsError('too_large', `The image does not fit into ${opts.maxBytes} bytes even when made smaller.`);
}

/** A stored screenshot as a feedback note keeps it: WebP, longer side ≤ SCREENSHOT_MAX_SIDE, ≤ SCREENSHOT_MAX_BYTES. */
export function reencodeScreenshot(input: Uint8Array, limits: ImageLimits = imageLimits()): Promise<EncodedImage> {
  return reencodeImage(input, { maxSide: SCREENSHOT_MAX_SIDE, maxBytes: limits.screenshotMaxBytes, format: 'webp' });
}

/** An image for an MCP image content block: JPEG, longer side ≤ MCP_IMAGE_MAX_SIDE, ≤ MCP_IMAGE_MAX_BYTES. */
export function reencodeForMcp(input: Uint8Array, limits: ImageLimits = imageLimits()): Promise<EncodedImage> {
  return reencodeImage(input, { maxSide: MCP_IMAGE_MAX_SIDE, maxBytes: limits.mcpImageMaxBytes, format: 'jpeg' });
}
