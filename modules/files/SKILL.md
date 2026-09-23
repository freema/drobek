# files — uploads the app stores

Use it whenever the people using the app upload something: photos, an
avatar, a PDF, a CSV. drobek stores the bytes and serves them from the app's
own host; the app calls `drobek.files`. Never use Firebase Storage, S3,
Cloudinary, UploadThing or data: URLs in records — they cannot run here.
Uploading needs a signed-in user by default (the auth module — read
`skill_info('auth')`).

## 1. Configure (`configure_module`, optional)

```json
{ "app_id": "…", "module": "files", "config": {
  "rules": { "upload": "user", "read": "user" },
  "maxBytes": 5242880,
  "allowedTypes": ["image/*", "application/pdf"] } }
```

- `rules.upload` / `rules.read`: `public | user | owner | admin | none`,
  joined with `|`. Defaults: `user` / `user` (signed-in users upload and
  see files; visitors nothing). `read: "owner|admin"` = each user sees only
  their own uploads. Deleting is always the uploader or an admin.
- `maxBytes` can only LOWER the server cap (`FILES_MAX_BYTES`, 10 MiB).
- `allowedTypes`: any of `image/*`, `image/png`, `image/jpeg`, `image/gif`,
  `image/webp`, `image/svg+xml`, `application/pdf`, `text/csv`. Nothing
  else can be stored (no HTML, JS, ZIP, Office files).
- `upload: "public"` (anyone fills the storage), or `read: "public"` while
  the app already holds files, **needs the owner's confirmation**:
  `configure_module` answers `applied: false` with a `confirm_url` for the user.

## 2. Minimal working code (react-ts template)

```tsx
// src/main.tsx
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { drobek } from 'drobek';
import { LoginGate } from 'drobek/auth';
import './styles.css';

type Photo = { id: string; url: string; name: string };

function Uploader() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [error, setError] = useState('');

  return (
    <main>
      <h1>My photos</h1>
      <input
        type="file"
        accept="image/*"
        aria-label="Upload a photo"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setError('');
          try {
            const stored = await drobek.files.upload(file);
            setPhotos((p) => [{ id: stored.id, url: stored.url, name: stored.name }, ...p]);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
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

To keep the uploads, store the ids in a record (`skill_info('data')`), e.g.
`drobek.data.collection('photos').create({ file: stored.id, caption })`, and
render `<img src={drobek.files.url(r.file)}>`. Store the id, not the URL.

## SDK

```ts
drobek.files.upload(file: Blob, { name?, signal? }?): Promise<StoredFile>   // 201
drobek.files.url(id): string                     // same-origin, e.g. <img src>, <a href download>
drobek.files.remove(id): Promise<{ id: string; deleted: true }>
drobek.files.list({ limit?, cursor? }?): Promise<{ files: StoredFile[]; next_cursor; used_bytes; quota_bytes }>  // admins
type StoredFile = { id; url; size; type; name; owner: string | null; created_at }
```

- The type is decided from the bytes, never from the name or the declared
  type: an HTML page renamed `.png` is refused. CSV must be sent as a
  `.csv` file (or `text/csv`) and be plain UTF-8 text.
- Raster images and PDFs open inline; SVG and CSV always download (an
  inline SVG could run scripts). Every file is sent with `nosniff`.
- REST: `POST /__drobek/v1/files` (multipart/form-data, ONE file part, any
  field name, header `X-Drobek-SDK: 1`), `GET /__drobek/v1/files`,
  `GET|DELETE /__drobek/v1/files/<id>`.

## Limits (per app)

- One file ≤ `FILES_MAX_BYTES` (10 MiB, or the config's `maxBytes`).
- All files of the app ≤ `FILES_QUOTA_PER_APP` (500 MiB).
- ≤ `FILES_UPLOAD_RATE_LIMIT` uploads per minute (60).
- The preview and the production host of an app share its files.
- Not in v1: resizing/thumbnails, EXIF stripping (photos keep their
  metadata — tell users), public galleries across apps.

## Errors

- `401 unauthorized` — the rule needs a signed-in user: wrap the UI in `<LoginGate>`.
- `403 forbidden` — not allowed by the rule (e.g. deleting someone else's file).
- `404 not_found` — no such file in this app.
- `413 payload_too_large` — the file is over the per-file cap (`details.value`).
- `415 unsupported_type` — the bytes are not an accepted type (`details.allowed`).
- `409 quota_exceeded` — the app's storage is full: delete files first.
- `429 rate_limited` — too many uploads; retry after `Retry-After` seconds.
