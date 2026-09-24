# files — uploads the app stores

## 1. When to use

People using the app upload something the app keeps and shows or offers
for download later: photos, an avatar, a PDF, a CSV. drobek stores the
bytes and serves them from the app's own host. Never use Firebase Storage,
S3, Cloudinary, UploadThing or data: URLs inside records. Uploads need a
signed-in user by default (`skill_info('auth')`).

## 2. Minimal working code

Works without configuration (signed-in users upload and read; images, PDF,
CSV). Keep the ids in a record (`skill_info('data')`) to list them later.

```tsx
// src/main.tsx
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { drobek, DrobekError } from 'drobek';
import { LoginGate } from 'drobek/auth';
import './styles.css';

type Photo = { id: string; name: string };

function Uploader() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setError('');
    try {
      const stored = await drobek.files.upload(file);
      setPhotos((p) => [{ id: stored.id, name: stored.name }, ...p]);
    } catch (err) {
      setError(err instanceof DrobekError ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>My photos</h1>
      <input type="file" accept="image/*" aria-label="Upload a photo" disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
      {busy && <p aria-busy="true">Uploading…</p>}
      {error && <p role="alert">{error}</p>}
      <ul>
        {photos.map((p) => (
          <li key={p.id}>
            <img src={drobek.files.url(p.id)} alt={p.name} width={160} />
            <button onClick={() => drobek.files.remove(p.id).then(() => setPhotos((all) => all.filter((x) => x.id !== p.id)))}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <LoginGate title="My photos">
    <Uploader />
  </LoginGate>
);
```

```json
{ "app_id": "…", "module": "files", "config": {
  "rules": { "upload": "user", "read": "owner|admin" }, "maxBytes": 5242880, "allowedTypes": ["image/*", "application/pdf"] } }
```

## 3. API and types

```ts api
// drobek.files
export interface StoredFile {
  id: string;
  url: string; // same-origin: <img src>, <a href download>, <iframe src> (PDF)
  size: number;
  type: string; // detected from the bytes: image/png|jpeg|gif|webp|svg+xml, application/pdf, text/csv
  name: string;
  owner: string | null; // the uploader's end-user id
  created_at: string;
}
export interface FilesPage { files: StoredFile[]; next_cursor: string | null; used_bytes: number; quota_bytes: number }
export interface Api {
  upload(file: Blob, opts?: { name?: string; signal?: AbortSignal }): Promise<StoredFile>;
  url(id: string): string; // store the id, build the URL when rendering
  remove(id: string): Promise<{ id: string; deleted: true }>; // the uploader or an admin
  list(opts?: { limit?: number; cursor?: string | null }): Promise<FilesPage>; // admins only
}
```

Config: `rules.upload` / `rules.read` = `public | user | owner | admin |
none` joined with `|` (defaults `user` / `user`; `read: "owner|admin"` =
each user sees only their own uploads; delete is always `owner|admin`);
`maxBytes` only LOWERS `FILES_MAX_BYTES`; `allowedTypes` ⊆ `image/*`,
`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml`,
`application/pdf`, `text/csv`. REST: `POST /__drobek/v1/files` (multipart,
ONE file part, `X-Drobek-SDK: 1`), `GET|DELETE /__drobek/v1/files/<id>`.

## 4. Rules and limits

- `upload: "public"`, or `read: "public"` while the app holds files, needs
  the owner's confirmation (`applied: false` + `confirm_url`).
- The type comes from the bytes, never the name: an HTML page renamed
  `.png` is refused; no HTML, JS, ZIP or Office files. CSV must be sent as
  `.csv` / `text/csv` and be UTF-8 text.
- Raster images and PDFs open inline; SVG and CSV always download. Every
  file is sent with `nosniff`, and every type but PDF with
  `Content-Security-Policy: sandbox` (opened as a page it runs no script).
- Caching: `read: "public"` files may sit in shared caches for 5 minutes
  (`max-age=300, must-revalidate`, then an ETag check); other files are
  revalidated on every use. A delete or a stricter `read` rule reaches
  every visitor within those 5 minutes.
- `FILES_MAX_BYTES` 10 MiB per file, `FILES_QUOTA_PER_APP` 500 MiB per app;
  uploads: `FILES_UPLOADS_PER_PRINCIPAL_PER_MIN` 20 per minute per user (or
  visitor IP), then `FILES_UPLOAD_RATE_LIMIT` 60 per minute per app.
- Preview and production share the files. No resizing/thumbnails, no EXIF
  stripping (photos keep their metadata).

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `unauthorized` (401) | the rule needs a signed-in user | wrap the UI in `<LoginGate>` |
| `forbidden` (403) | the rule refuses (e.g. deleting someone else's file) | hide the action |
| `not_found` (404) | no such file in this app | drop the stale id |
| `payload_too_large` (413) | over the per-file cap (`details.value`) | tell the user the limit |
| `unsupported_type` (415) | the bytes are no accepted type (`details.allowed`) | accept only those types in `<input accept>` |
| `quota_exceeded` (409) | the app's storage is full | delete files first |
| `rate_limited` (429) | too many uploads | retry after `Retry-After` |
| `invalid_params` | configure_module: bad rule or type | read `issues[].path` |
