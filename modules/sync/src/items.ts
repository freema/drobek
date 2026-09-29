/**
 * From an upstream's JSON answer to the records of one run: the array at the
 * source's `items` path ('' = the answer itself), each element a JSON object.
 * Pure; every refusal is a SyncRunError whose message names the problem but
 * never quotes the answer (it is the upstream's data, maybe private).
 */
export class SyncRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncRunError';
  }
}

/** "data.players", "results[0].items" → ['data', 'players'], ['results', 0, 'items']. */
export function itemsPath(path: string): (string | number)[] {
  if (path === '') return [];
  const out: (string | number)[] = [];
  for (const part of path.split('.')) {
    const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) throw new SyncRunError(`the items path "${path}" is not a dotted path`);
    out.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

function kind(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

/** The records at `path` of `value` (at most `maxRecords`), or a SyncRunError. */
export function pickRecords(value: unknown, path: string, maxRecords: number): Record<string, unknown>[] {
  let cur: unknown = value;
  const walked: string[] = [];
  for (const seg of itemsPath(path)) {
    walked.push(typeof seg === 'number' ? `[${seg}]` : seg);
    if (typeof seg === 'number') {
      if (!Array.isArray(cur) || seg >= cur.length) throw new SyncRunError(`the response has no "${walked.join('.').replace(/\.\[/g, '[')}"`);
      cur = cur[seg];
    } else {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) {
        throw new SyncRunError(`the response has no "${walked.join('.').replace(/\.\[/g, '[')}"`);
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  const where = path === '' ? 'the response' : `"${path}"`;
  if (!Array.isArray(cur)) throw new SyncRunError(`${where} is ${kind(cur)}, not an array of records — set "items" to the path of the array`);
  if (cur.length > maxRecords) {
    throw new SyncRunError(`${where} holds ${cur.length} records; one run imports at most ${maxRecords} (SYNC_MAX_RECORDS_PER_RUN) — ask the upstream for fewer (a filter or a page size in the path)`);
  }
  return cur.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SyncRunError(`record ${i} of ${where} is ${kind(item)}, not an object`);
    return item as Record<string, unknown>;
  });
}
