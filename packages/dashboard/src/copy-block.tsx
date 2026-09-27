/**
 * A copyable snippet: the text in a code box and a Copy button with a
 * readable result. When the browser refuses the copy, the text is selected
 * so the user can copy it by hand. Client-safe.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { controls, mergeStyles } from '@drobek/tenancy/layout';
import { copyText, type CopyResult } from './copy.js';

const styles = {
  wrap: { margin: '0.4rem 0 0.6rem' },
  row: { display: 'flex', gap: '0.5rem', alignItems: 'flex-start' },
  code: {
    flex: '1 1 auto',
    minWidth: 0,
    margin: 0,
    padding: '0.45rem 0.7rem',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.85rem',
    lineHeight: 1.5,
    background: '#f4f4f5',
    border: '1px solid #e4e4e7',
    borderRadius: '6px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontVariantLigatures: 'none',
  },
  status: { minHeight: '1rem', margin: '0.2rem 0 0', fontSize: '0.8rem' },
  ok: { color: '#166534' },
  failed: { color: '#991b1b' },
} satisfies Record<string, CSSProperties>;

export function CopyBlock({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [result, setResult] = useState<CopyResult | null>(null);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (result !== 'copied') return;
    const t = setTimeout(() => setResult(null), 2500);
    return () => clearTimeout(t);
  }, [result]);

  async function onCopy() {
    const r = await copyText(value, typeof navigator === 'undefined' ? undefined : navigator.clipboard);
    if (r === 'failed' && codeRef.current) {
      const range = document.createRange();
      range.selectNodeContents(codeRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    setResult(r);
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.row}>
        <code ref={codeRef} style={styles.code} data-testid={testId}>
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          style={mergeStyles(controls.secondaryButton, { flex: 'none' })}
          aria-label={`Copy ${label}`}
          data-testid={testId ? `${testId}-copy` : undefined}
        >
          {result === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p role="status" aria-live="polite" style={styles.status} data-testid={testId ? `${testId}-copy-status` : undefined}>
        {result === 'copied' ? (
          <span style={styles.ok}>{label} copied to the clipboard.</span>
        ) : result === 'failed' ? (
          <span style={styles.failed}>
            Your browser did not allow copying. The text is selected — press Ctrl+C (⌘C on a Mac) to copy it.
          </span>
        ) : null}
      </p>
    </div>
  );
}
