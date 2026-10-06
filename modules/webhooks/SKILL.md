# webhooks — receive signed webhooks from other services into a data collection

## 1. When to use

Another service has to tell the app that something happened: a payment
succeeded, a repository got a push, a form service received an entry —
anything that POSTs a webhook signed with a shared secret. drobek gives
each endpoint an address on the app's host, verifies every delivery
against the secret the OWNER entered in the dashboard, and stores it as a
record of a `data` collection. No app code runs on the server: the app
reads the records with `drobek.data` in the browser. Use `forms` instead
when visitors submit the data, and `sync` when the app has to fetch it
from an API on a schedule.

## 2. Minimal working code

1. The collection (`skill_info('data')`). Give it no schema, or one that
   accepts `{ source, event_type, event_id, received_at, payload }`; only
   admins read it, nobody writes it from the browser:

```json
{ "app_id": "…", "module": "data", "config": { "collections": { "payments": {
  "rules": { "read": "admin", "create": "none", "update": "none", "delete": "admin" } } } } }
```

2. The endpoint (the owner confirms it: the answer has `confirm_url`):

```json
{ "app_id": "…", "module": "webhooks", "config": { "endpoints": {
  "payments": { "collection": "payments", "verify": "stripe" } } } }
```

3. Tell the user, in this order: confirm the endpoint at `confirm_url`;
   copy the URL from `get_app` → `modules.webhooks.info.endpoints[].url`
   (`https://<app host>/__drobek/v1/webhooks/payments`) into the sending
   service; paste the service's signing secret into the secret
   `WEBHOOK_SECRET_PAYMENTS` on the webhooks module page in the dashboard.
   Never ask for the secret in chat — no tool takes it.

```tsx
// src/main.tsx
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { drobek } from 'drobek';
import './styles.css';

type Delivery = { source: string; event_type?: string; received_at: string; payload: unknown };

function Payments() {
  const [rows, setRows] = useState<(Delivery & { _id: string })[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    drobek.data
      .collection<Delivery>('payments')
      .list({ sort: '_created_at', dir: 'desc', limit: 50 })
      .then((page) => setRows(page.records))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the payments'));
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!rows) return <p>Loading…</p>;
  if (rows.length === 0) return <p>No payments received yet.</p>;
  return (
    <ul>
      {rows.map((r) => (
        <li key={r._id}>
          {r.event_type ?? 'event'} — {new Date(r.received_at).toLocaleString()}
        </li>
      ))}
    </ul>
  );
}

createRoot(document.getElementById('root')!).render(<Payments />);
```

## 3. API and types

An endpoint `endpoints.<name>` (lowercase letters, digits, `-`, `_`; it is
the last part of the URL):

- `collection` — declared in the data config (required).
- `verify` — `hmac-sha256` (default: HMAC-SHA256 of the raw body in
  `header`, default `X-Webhook-Signature`, as hex, `sha256=<hex>` or
  base64), `stripe` (`Stripe-Signature` with a timestamp), `github`
  (`X-Hub-Signature-256`), or `none-with-token` (the secret itself in
  `header`, default `X-Webhook-Token`, or `?token=` in the URL — only for a
  service that cannot sign).
- `secret` — the secret's name (default `WEBHOOK_SECRET_<NAME>`, `-` → `_`).
- `id_header` — the header with the sender's event id (default
  `Webhook-Id`; stripe uses the body's `id`, github `X-GitHub-Delivery`).
- `max_bytes` — a lower body cap than `WEBHOOKS_MAX_BODY_BYTES`.
- `enabled` — `false` answers 404 and stores nothing.

Every accepted delivery is one record (no `_owner`): `source` (the
endpoint), `event_type` (stripe `type`, github `X-GitHub-Event`, else the
body's `type` or `event`), `event_id`, `received_at` (ISO) and `payload` (the
JSON body; a form body as its fields; anything else as text).

`get_app` → `modules.webhooks.info.endpoints[]` has each endpoint's `url`,
`verify`, `secret`, `last_status`; `modules.webhooks.secrets[]` says whether
each secret is set (`hasSecret`). `get_logs({ app_id, kind: "webhooks" })`
lists the latest deliveries: `{ endpoint, status, http_status, bytes,
reason, record_id, received_at }` — never a body.

## 4. Rules and limits

- A new endpoint, a changed `collection` and a switch to `none-with-token`
  wait for the owner's confirmation; the rest applies at once.
- The signature is checked over the raw body, in constant time; `stripe`
  deliveries older or newer than 5 minutes are refused (replay).
- A delivery whose event id was stored in the last 7 days answers 200 and
  stores nothing (`duplicate`): senders retry, the app sees one record.
- `WEBHOOKS_MAX_BODY_BYTES` 256 KiB (never above 1 MiB);
  `WEBHOOKS_PER_APP_PER_MINUTE` 120; `WEBHOOKS_MAX_ENDPOINTS_PER_APP` 10.
  The data quotas apply to every record; a record over `DATA_MAX_DOC_BYTES`
  (100 KiB) is refused with 413, so that is the real cap by default.
- The app's password does not apply to the endpoint (the signature does).
- Statuses in the log: `accepted`, `rejected_signature`, `duplicate`,
  `too_large`, `rate_limited`, `collection_error`; kept 30 days.

## 5. Errors → fix

The sender gets these; the agent sees them in `get_logs({ kind: "webhooks" })`.

| error | cause | fix |
|---|---|---|
| `invalid_signature` | wrong secret, wrong `verify`, tampered body, stale stripe timestamp | the owner re-copies the signing secret; match `verify` to the service |
| `webhook_secret_not_set` | the endpoint's secret is not set (`hasSecret: false`) | the owner sets it on the module page; the sender's retry lands |
| `webhook_not_stored` | the collection is missing, its schema rejects the record, or quota | declare it / relax the schema; the retry lands |
| `not_found` | no such endpoint, or it is disabled | check the URL's last part and `enabled` |
| `payload_too_large` | the body is over `max_bytes` / `WEBHOOKS_MAX_BODY_BYTES`, or its record over `DATA_MAX_DOC_BYTES` | raise `max_bytes` (≤ the server cap); a record cap is the operator's |
| `rate_limited` | over `WEBHOOKS_PER_APP_PER_MINUTE` | the sender retries later |
| `invalid_params` | bad config or too many endpoints | fix the named field |
