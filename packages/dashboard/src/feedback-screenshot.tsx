/**
 * The optional screenshot of a feedback note (/feedback/new): a file input
 * named `screenshot` that the form sends as multipart — all there is without
 * JavaScript. With JavaScript the page also offers Capture a tab
 * (getDisplayMedia: the person picks the tab with the app, this window is
 * excluded, the first frame is taken and the stream stopped at once) and
 * pasting an image (e.g. a system screenshot from the clipboard). Whatever
 * the source, the image is drawn into a canvas no larger than `maxSide` and
 * encoded as WebP (JPEG where the browser cannot) at most `maxBytes`, then
 * placed into the file input; a preview with Remove shows what will be sent.
 * The server re-encodes it again either way and never keeps the upload.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { fitWithin } from './feedback-view.js';

const ACCEPT = 'image/png,image/jpeg,image/webp';
const QUALITIES = [0.85, 0.72, 0.6, 0.48, 0.36];

const s = {
  box: { border: '1px dashed #d4d4d8', borderRadius: '8px', padding: '0.7rem 0.8rem', margin: '1rem 0 0' },
  label: { display: 'block', fontWeight: 600, margin: '0 0 0.35rem' },
  hint: { color: '#555', fontSize: '0.82rem', margin: '0.35rem 0 0' },
  row: { display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.4rem' },
  button: {
    padding: '0.45rem 0.85rem',
    fontSize: '0.9rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#1a1a1a',
    background: '#fff',
    border: '1px solid #a1a1aa',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  preview: { display: 'block', maxWidth: '100%', maxHeight: '16rem', height: 'auto', border: '1px solid #e4e4e7', borderRadius: '6px', marginTop: '0.5rem' },
  error: { color: '#b91c1c', fontSize: '0.85rem', margin: '0.4rem 0 0' },
} satisfies Record<string, CSSProperties>;

interface Prepared {
  url: string;
  width: number;
  height: number;
  bytes: number;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** The source drawn into a canvas within `maxSide`, encoded within `maxBytes` (WebP, else JPEG), or null. */
async function encode(source: CanvasImageSource, width: number, height: number, maxSide: number, maxBytes: number): Promise<{ blob: Blob; width: number; height: number } | null> {
  let size = fitWithin(width, height, maxSide);
  for (let step = 0; step < 6; step++) {
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(source, 0, 0, size.width, size.height);
    for (const q of QUALITIES) {
      let blob = await canvasBlob(canvas, 'image/webp', q);
      if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(canvas, 'image/jpeg', q);
      if (blob && blob.size <= maxBytes) return { blob, ...size };
    }
    size = fitWithin(size.width, size.height, Math.floor(Math.max(size.width, size.height) * 0.75));
  }
  return null;
}

export function FeedbackScreenshotField({ maxBytes, maxSide }: { maxBytes: number; maxSide: number }) {
  const input = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [canCapture, setCanCapture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState<Prepared | null>(null);

  useEffect(() => {
    setReady(true);
    setCanCapture(typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function');
  }, []);

  useEffect(() => () => {
    if (prepared) URL.revokeObjectURL(prepared.url);
  }, [prepared]);

  const clear = useCallback(() => {
    if (input.current) input.current.value = '';
    setPrepared(null);
  }, []);

  const place = useCallback(
    async (source: CanvasImageSource, width: number, height: number) => {
      const out = await encode(source, width, height, maxSide, maxBytes);
      if (!out || !input.current) {
        clear();
        setError('This image could not be made small enough to send. Crop it, or take a smaller screenshot.');
        return;
      }
      const ext = out.blob.type === 'image/webp' ? 'webp' : 'jpg';
      const file = new File([out.blob], `screenshot.${ext}`, { type: out.blob.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.current.files = dt.files;
      setPrepared({ url: URL.createObjectURL(out.blob), width: out.width, height: out.height, bytes: out.blob.size });
    },
    [clear, maxBytes, maxSide]
  );

  const fromFile = useCallback(
    async (file: File) => {
      setError('');
      if (!ACCEPT.split(',').includes(file.type)) {
        clear();
        setError('Choose a PNG, JPEG or WebP image.');
        return;
      }
      setBusy(true);
      try {
        const bitmap = await createImageBitmap(file);
        try {
          await place(bitmap, bitmap.width, bitmap.height);
        } finally {
          bitmap.close();
        }
      } catch {
        clear();
        setError('This file could not be read as an image. Choose another one.');
      } finally {
        setBusy(false);
      }
    },
    [clear, place]
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => ACCEPT.split(',').includes(f.type));
      if (!file) return;
      e.preventDefault();
      void fromFile(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [fromFile]);

  const capture = useCallback(async () => {
    setError('');
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
      } as DisplayMediaStreamOptions);
      setBusy(true);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const { videoWidth: w, videoHeight: h } = video;
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      if (!w || !h) throw new Error('empty frame');
      await place(video, w, h);
      video.srcObject = null;
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'NotAllowedError')) {
        setError('The tab could not be captured. Take a screenshot yourself and choose or paste it instead.');
      }
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setBusy(false);
    }
  }, [place]);

  return (
    <div style={s.box} data-testid="feedback-screenshot-field">
      <label style={s.label} htmlFor="feedback-screenshot">
        Screenshot (optional)
      </label>
      <div style={s.row}>
        {ready && canCapture ? (
          <button type="button" style={s.button} onClick={() => void capture()} disabled={busy} data-testid="feedback-capture">
            Capture a tab
          </button>
        ) : null}
        <input
          ref={input}
          id="feedback-screenshot"
          name="screenshot"
          type="file"
          accept={ACCEPT}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) void fromFile(file);
            else setPrepared(null);
          }}
          data-testid="feedback-screenshot-input"
        />
      </div>
      <p style={s.hint}>
        {ready
          ? `${canCapture ? 'Capture the tab with the app, choose' : 'Choose'} a PNG, JPEG or WebP, or paste one from the clipboard. It is made smaller before sending and kept without its metadata.`
          : `A PNG, JPEG or WebP of at most ${Math.round(maxBytes / 1024)} KiB. It is kept without its metadata.`}
      </p>
      {busy ? (
        <p style={s.hint} aria-live="polite">
          Preparing the screenshot…
        </p>
      ) : null}
      {prepared ? (
        <div data-testid="feedback-screenshot-preview">
          <img src={prepared.url} alt="The screenshot that will be sent with the note" style={s.preview} />
          <div style={s.row}>
            <span style={s.hint}>
              {prepared.width}×{prepared.height} · {Math.max(1, Math.round(prepared.bytes / 1024))} KiB
            </span>
            <button type="button" style={s.button} onClick={clear} data-testid="feedback-screenshot-remove">
              Remove
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p style={s.error} role="alert" data-testid="feedback-screenshot-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
