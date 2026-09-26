/**
 * /workspaces/:slug/apps/:appSlug/assets — client half of the Assets tab
 * (NSO-358): the app's video, audio, images and fonts, served at `/<path>`
 * next to its files. A list (path, type, size, copy path, open on the
 * preview host) with the quota; upload and (after a confirm step) delete for
 * editors, read-only for viewers.
 *
 * Upload: pick or drop a file → the action mints a single-use upload URL →
 * the browser PUTs the file to it with a progress bar (the bytes never go
 * through the action) → the list reloads. Without script the form asks for
 * the path and size and shows the upload link (a browser upload page) and a
 * curl line instead.
 */
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Form, Link, useActionData, useFetcher, useLoaderData, useRevalidator } from 'react-router';
import type { AssetsActionData, loader } from './workspaces.$slug.apps.$appSlug.assets.server.js';
import { ui } from '../owner-ui.js';
import { AppPage } from '../app-header.js';
import { suggestAssetPath } from '../owner-view.js';
import { formatTimestamp } from '../view.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Assets — ${data?.appSlug ?? 'App'} — drobek` }];
}

const dropZone = {
  border: '1px dashed #c4c4cc',
  borderRadius: '10px',
  padding: '0.9rem 1rem',
  margin: '1rem 0',
  background: '#fcfcfd',
} as const;
const bar = { width: '100%', height: '6px', margin: '0.5rem 0 0' } as const;

type Status = { kind: 'idle' } | { kind: 'uploading'; percent: number } | { kind: 'done'; path: string } | { kind: 'error'; message: string };

function Uploader({ maxBytes, maxText }: { maxBytes: number; maxText: string }) {
  const fetcher = useFetcher<AssetsActionData>();
  const revalidator = useRevalidator();
  const [hydrated, setHydrated] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState('');
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const sent = useRef<string | null>(null);
  useEffect(() => setHydrated(true), []);

  const choose = (f: File | null | undefined) => {
    if (!f) return;
    setFile(f);
    setPath(suggestAssetPath(f.name));
    setStatus(f.size > maxBytes ? { kind: 'error', message: `The file is larger than ${maxText} (APP_ASSET_MAX_BYTES).` } : { kind: 'idle' });
  };

  // The upload URL arrived: PUT the file to it (once per URL).
  useEffect(() => {
    const d = fetcher.data;
    if (!d || !file) return;
    if (d.error) {
      setStatus({ kind: 'error', message: d.error });
      return;
    }
    if (!('uploadUrl' in d) || sent.current === d.uploadUrl) return;
    sent.current = d.uploadUrl;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', d.uploadUrl);
    if (file.type) xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setStatus({ kind: 'uploading', percent: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.onload = () => {
      let body: { message?: string } = {};
      try {
        body = JSON.parse(xhr.responseText) as { message?: string };
      } catch {
        // not JSON — the status line says enough
      }
      if (xhr.status === 201) {
        setStatus({ kind: 'done', path: d.assetPath });
        setFile(null);
        revalidator.revalidate();
      } else {
        setStatus({ kind: 'error', message: body.message ?? `Upload failed (HTTP ${xhr.status}).` });
      }
    };
    xhr.onerror = () => setStatus({ kind: 'error', message: 'The upload was interrupted. Try again.' });
    setStatus({ kind: 'uploading', percent: 0 });
    xhr.send(file);
  }, [fetcher.data, file, revalidator]);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    choose(e.dataTransfer.files?.[0]);
  };

  if (!hydrated) {
    // Without script: ask for the path and size, answer with the upload link.
    return (
      <Form method="post" style={ui.toolbar} data-testid="asset-upload-form">
        <input type="hidden" name="intent" value="upload-url" />
        <label style={ui.field}>
          <span style={ui.label}>Path</span>
          <input name="path" required placeholder="film.mp4" style={ui.input} />
        </label>
        <label style={ui.field}>
          <span style={ui.label}>Size (bytes)</span>
          <input name="size" required inputMode="numeric" style={ui.input} />
        </label>
        <button type="submit" style={ui.button}>
          Get upload link
        </button>
      </Form>
    );
  }

  const busy = fetcher.state !== 'idle' || status.kind === 'uploading';
  return (
    <div
      style={{ ...dropZone, ...(dragging ? { borderColor: '#1e3a8a', background: '#f5f7ff' } : {}) }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-testid="asset-drop-zone"
    >
      <fetcher.Form
        method="post"
        style={{ ...ui.toolbar, margin: 0, border: 'none', padding: 0, background: 'transparent' }}
        data-testid="asset-upload-form"
        onSubmit={() => {
          sent.current = null;
        }}
      >
        <input type="hidden" name="intent" value="upload-url" />
        <input type="hidden" name="size" value={file ? String(file.size) : ''} />
        <input type="hidden" name="type" value={file?.type ?? ''} />
        <label style={ui.field}>
          <span style={ui.label}>File</span>
          <input type="file" accept="video/*,audio/*,image/*,.woff,.woff2" onChange={(e) => choose(e.target.files?.[0])} data-testid="asset-file" />
        </label>
        <label style={ui.field}>
          <span style={ui.label}>Path in the app</span>
          <input name="path" value={path} onChange={(e) => setPath(e.target.value)} required placeholder="film.mp4" style={ui.input} data-testid="asset-path" />
        </label>
        <button type="submit" style={ui.button} disabled={!file || busy || (file && file.size > maxBytes)} data-testid="asset-upload">
          Upload
        </button>
      </fetcher.Form>
      <p style={{ ...ui.muted, margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
        Drop a file here or pick one — video (MP4, WebM), audio (MP3, M4A, Ogg, WAV), images or fonts, up to {maxText}. The page links it by its path, e.g.{' '}
        <code style={ui.mono}>&lt;video src=&quot;{path || 'film.mp4'}&quot; controls&gt;</code>.
      </p>
      {status.kind === 'uploading' ? (
        <progress style={bar} max={100} value={status.percent} data-testid="asset-progress" aria-label="Upload progress" />
      ) : null}
      {status.kind === 'done' ? (
        <div style={ui.notice} role="status" data-testid="asset-upload-done">
          Uploaded — the app serves it at <code style={ui.mono}>{status.path}</code>.
        </div>
      ) : null}
      {status.kind === 'error' ? (
        <div style={ui.error} role="alert" data-testid="asset-upload-error">
          {status.message}
        </div>
      ) : null}
    </div>
  );
}

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      style={ui.smallButton}
      data-testid="asset-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(path).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy path'}
    </button>
  );
}

export default function AppAssetsRoute() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<AssetsActionData>();
  const base = `/workspaces/${d.workspace.slug}/apps/${d.appSlug}/assets`;

  return (
    <AppPage header={d.header}>
      <h2 style={ui.title}>Assets</h2>
      <p style={ui.hint}>
        Video, audio, images and fonts of <strong>{d.appSlug}</strong>, served at their path next to the app&apos;s files on every host. Types are decided
        from the bytes. Agents upload them with <code style={ui.mono}>create_asset_upload</code>.
      </p>
      <p style={ui.muted} data-testid="assets-usage">
        {d.used} of {d.quota} used · up to {d.maxText} per file
      </p>

      {d.canEdit ? <Uploader maxBytes={d.maxBytes} maxText={d.maxText} /> : null}

      {actionData?.error ? (
        <div style={ui.error} role="alert" data-testid="action-error">
          {actionData.error}
        </div>
      ) : null}
      {actionData && 'uploadUrl' in actionData && actionData.uploadUrl ? (
        <div style={ui.panel} data-testid="asset-upload-link">
          <p style={{ margin: 0 }}>
            Open <a href={actionData.uploadUrl} style={ui.link}>the upload page</a> (single use, valid 30 minutes), or run:
          </p>
          <pre style={ui.pre}>{actionData.curl}</pre>
        </div>
      ) : null}

      {d.assets.length === 0 ? (
        <p style={ui.empty} data-testid="assets-empty">
          No assets yet.
        </p>
      ) : (
        <div style={ui.tableWrap}>
          <table style={ui.table} data-testid="assets-table">
            <thead>
              <tr>
                <th style={ui.th}>Path</th>
                <th style={ui.th}>Type</th>
                <th style={ui.th}>Size</th>
                <th style={ui.th}>Uploaded</th>
                <th style={ui.th} />
              </tr>
            </thead>
            <tbody>
              {d.assets.map((a) => (
                <tr key={a.path} data-testid="asset-row" data-path={a.path}>
                  <td style={ui.td}>
                    <a href={a.url} style={{ ...ui.link, ...ui.mono }} target="_blank" rel="noreferrer">
                      {a.path}
                    </a>
                  </td>
                  <td style={ui.td}>
                    <code style={ui.mono}>{a.type}</code>
                  </td>
                  <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>{a.sizeText}</td>
                  <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>{formatTimestamp(a.updatedAt)}</td>
                  <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>
                    <CopyPath path={a.path} />{' '}
                    {d.canEdit ? (
                      d.confirmPath === a.path ? (
                        <Form method="post" style={{ display: 'inline' }} data-testid="asset-delete-form">
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="path" value={a.path} />
                          <button type="submit" style={ui.dangerButton} data-testid="asset-delete-confirm">
                            Confirm delete
                          </button>{' '}
                          <Link to={base} style={ui.link}>
                            Cancel
                          </Link>
                        </Form>
                      ) : (
                        <Link to={`${base}?confirm=${encodeURIComponent(a.path)}`} style={ui.dangerLink} data-testid="asset-delete">
                          Delete
                        </Link>
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppPage>
  );
}
