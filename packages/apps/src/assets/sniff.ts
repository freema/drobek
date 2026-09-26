/**
 * The streaming type check of an asset upload (NSO-358): `update()` every
 * chunk, then `finish()`. Binary types come from their signature
 * (@drobek/core `sniffSignature`, shared with the files module); SVG is the
 * one text type: the whole stream must be UTF-8 without control characters
 * and start with an `<svg` root (`looksLikeSvg`). `rejected` turns true as
 * soon as the bytes can be no asset type at all, so an upload stops early.
 */
import { SIGNATURE_HEAD_BYTES, hasControlBytes, looksLikeSvg, sniffSignature } from '@drobek/core';
import { isAssetType, type AssetType } from './names.js';

/** Bytes of the head the SVG root check looks at. */
const SVG_HEAD_BYTES = 16 * 1024;

export class AssetSniffer {
  private head = Buffer.alloc(0);
  private binary: AssetType | null | undefined = undefined;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private text = true;
  private bytes = 0;

  update(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.head.length < SVG_HEAD_BYTES) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, SVG_HEAD_BYTES - this.head.length)]);
    }
    if (this.binary === undefined && this.head.length >= SIGNATURE_HEAD_BYTES) this.binary = this.signature();
    if (this.binary) return;
    if (this.text) {
      if (hasControlBytes(chunk)) {
        this.text = false;
        return;
      }
      try {
        this.decoder.decode(chunk, { stream: true });
      } catch {
        this.text = false;
      }
    }
  }

  private signature(): AssetType | null {
    const t = sniffSignature(this.head);
    return t !== null && isAssetType(t) ? t : null;
  }

  /** True once the bytes can no longer be any asset type. */
  get rejected(): boolean {
    return this.binary === null && !this.text;
  }

  /** The type of the whole upload, or null (not an asset type). */
  finish(): AssetType | null {
    if (this.bytes === 0) return null;
    if (this.binary === undefined) this.binary = this.signature();
    if (this.binary) return this.binary;
    if (!this.text) return null;
    try {
      this.decoder.decode(); // a truncated multi-byte sequence at the end throws
    } catch {
      return null;
    }
    let head = this.head.toString('utf8');
    if (head.charCodeAt(0) === 0xfeff) head = head.slice(1); // a UTF-8 BOM
    return looksLikeSvg(head) ? 'image/svg+xml' : null;
  }
}

/** Sniff a whole buffer (tests, small inputs). */
export function sniffAsset(bytes: Buffer): AssetType | null {
  const s = new AssetSniffer();
  s.update(bytes);
  return s.finish();
}
