# sync — keep a data collection filled from an external API on a schedule

## 1. When to use

The app shows data that lives in an external API and should refresh on its
own: fantasy-sports players and scores, prices, fixtures, a feed — what is
otherwise a cron job, a scheduled task or a periodic update. drobek
fetches the JSON on a schedule (every 5 minutes at the least) through an
upstream of the proxy module — the API key stays in the dashboard — and
writes the records into a `data` collection. No app code runs on the
server, so there are no cron scripts: anything computed from the records
happens in the browser, which reads the collection with `drobek.data`.
Use `proxy` directly instead when the app needs the answer per visitor, at
the moment of the click.

## 2. Minimal working code

Four steps, the first two from other skills:

1. The upstream is registered and assigned to the app (`skill_info('proxy')`:
   `register_upstream`, then `configure_module('proxy', { upstreams:
   { "sportsapi": { rules: { call: "none" } } } })` — `call: "none"` keeps the
   browser off it; a workspace admin confirms).
2. The collection exists (`skill_info('data')`), best with a schema:

```json
{ "app_id": "…", "module": "data", "config": { "collections": { "players": {
  "rules": { "read": "public", "create": "none", "update": "none", "delete": "none" },
  "schema": { "type": "object", "required": ["id", "name", "points"],
    "properties": { "id": { "type": "integer" }, "name": { "type": "string" }, "team": { "type": "string" }, "points": { "type": "number" } } } } } } }
```

3. The source (the owner confirms it: the answer has `confirm_url`):

```json
{ "app_id": "…", "module": "sync", "config": { "sources": { "players": {
  "upstream": "sportsapi", "path": "/v3/players?league=1&season=2026",
  "every": "15m", "collection": "players", "items": "response", "key": "id", "mode": "upsert" } } } }
```

4. After the confirmation, `sync_now({ app_id, source: "players" })` runs it
   once and answers `{ status, records, error }`; then it runs on schedule.

```tsx
// src/main.tsx
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { drobek } from 'drobek';
import './styles.css';

type Player = { id: number; name: string; team?: string; points: number };

function Leaderboard() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    drobek.data
      .collection<Player>('players')
      .list({ sort: 'points', dir: 'desc', limit: 50 })
      .then((page) => setPlayers(page.records))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the players'));
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!players) return <p>Loading…</p>;
  if (players.length === 0) return <p>No players yet — the first import runs within minutes.</p>;
  return (
    <ol>
      {players.map((p) => (
        <li key={p.id}>
          {p.name} {p.team ? `(${p.team})` : ''} — {p.points} pts
        </li>
      ))}
    </ol>
  );
}

createRoot(document.getElementById('root')!).render(<Leaderboard />);
```

## 3. API and types

A source `sources.<name>` (name: lowercase letters, digits, `-`, `_`):

- `upstream` — assigned to this app in the proxy config; `path` (default
  `/`, with `?query`) below its base URL, inside its allowed prefixes;
  `method` `GET` (default) or `POST` with an optional `body` (JSON text).
- `every` — `"5m"`, `"15m"`, `"1h"`, `"1d"` (default `"1h"`).
- `collection` — declared in the data config; `items` — the dotted path
  of the array in the answer (`"data.players"`, `"results[0].items"`;
  `""` = the answer is the array). Every element must be an object; its
  fields become the record (keys starting with `_` are dropped).
- `mode` — `replace` (default: afterwards the collection holds exactly the
  fetched records) or `upsert` with `key` (the field that identifies a
  record: a record with the same key is replaced, new ones are added,
  others stay).
- `paused: true` stops the schedule; `null` removes the key again.

Tools: `sync_now({ app_id, source })` (editor+) runs a source now — also a
paused one — and returns the run `{ source, status: "ok" | "failed",
records, inserted?, updated?, deleted?, error, started_at, duration_ms }`.
`get_logs({ app_id, kind: "sync" })` lists the latest runs (newest first);
`get_app` → `modules.sync.info.sources[]` shows each source's `paused`,
`failures`, `last_status`, `last_records`, `last_error`.

## 4. Rules and limits

- A new source, or a changed `upstream`, `path`, `method`, `body`,
  `collection` or `mode`, waits for the owner's confirmation; `every`,
  `items`, `key` and `paused` apply at once.
- A run is all or nothing: the whole batch passes the collection's schema
  and quota, or nothing changes and the old records stay.
- `SYNC_MIN_INTERVAL_MIN` 5 minutes; `SYNC_MAX_SOURCES_PER_APP` 10;
  `SYNC_MAX_RESPONSE_BYTES` 5 MiB; `SYNC_MAX_RECORDS_PER_RUN` 1000 (more →
  the run fails: page the upstream with the path);
  `SYNC_RUNS_PER_HOUR_PER_APP` 60 (scheduled + by hand);
  `SYNC_NOW_PER_MINUTE` 2 per source. The data quotas
  (`DATA_MAX_DOCS_PER_APP` …) apply to what a run writes.
- A failed run backs the next one off (the interval, doubling); after
  `SYNC_PAUSE_AFTER_FAILURES` (5) failures in a row the source pauses and
  the dashboard shows a banner. A successful `sync_now`, the owner's
  Resume, or a changed source config starts it again.
- Records written by sync have no `_owner`; give the collection
  `create/update/delete: "none"` so visitors cannot change them.

## 5. Errors → fix

A failed run is not a tool error: `status: "failed"` with `error` — e.g.
`the upstream answered HTTP 401` (the key: the owner re-enters it in the
dashboard), `the response has no "data.players"` (fix `items`), `Record 3:
points must be number` (fix the schema or the source), a proxy refusal
(`upstream_not_assigned`, `path_not_allowed` … — see `skill_info('proxy')`).

| error | cause | fix |
|---|---|---|
| `not_found` | no such source (`details.available`), or the server runs no sync module | use a listed name; `skill_info()` lists the modules |
| `rate_limited` | `SYNC_NOW_PER_MINUTE` or the hourly budget spent | wait `retry_after_seconds`; never loop |
| `conflict` | a run of the source is in progress | wait, then `get_logs({ kind: "sync" })` |
| `limit_exceeded` | the source is past `SYNC_MAX_SOURCES_PER_APP` | remove a source |
| `invalid_params` | bad config, too many sources, `every` below the minimum | fix the named field |
| `module_not_enabled` | the operator has not enabled sync for this workspace | ask the operator |
