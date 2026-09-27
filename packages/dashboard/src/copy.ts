/**
 * Clipboard copy for the dashboard's Copy buttons. The Clipboard API is
 * missing on plain-http origins other than localhost and can be refused by
 * the browser or a permission policy, so a copy reports failure instead of
 * throwing and the page falls back to selecting the text.
 */
export type CopyResult = 'copied' | 'failed';

interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export async function copyText(text: string, clipboard: ClipboardLike | undefined): Promise<CopyResult> {
  if (!clipboard || typeof clipboard.writeText !== 'function') return 'failed';
  try {
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
