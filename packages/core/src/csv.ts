/**
 * RFC-4180 CSV cells with spreadsheet formula-injection neutralization
 * (PHY-76 #5) — the ONE CSV writer of drobek: the data module's export, the
 * forms submissions export, the dashboard's Data tab and Activity exports all
 * serialize every cell through `csvLine`. `parseCsv` is its reader (the
 * dashboard's CSV import of the data module): RFC-4180, bounded rows.
 */

/**
 * A cell that would be parsed as a formula by Excel / LibreOffice / Sheets when
 * the file is opened: leading `= + - @`, or a leading control char (tab, CR)
 * that some apps strip before they look for the trigger. Record values written
 * by an app's visitors are attacker-controlled, so an exported `=cmd|…` or
 * `=HYPERLINK(…)` cell would execute in the owner's spreadsheet.
 */
const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Escape one CSV field: first neutralize spreadsheet formula injection (prefix a
 * single quote so the cell is treated as literal text), then apply RFC-4180
 * quoting (wrap in quotes + double internal quotes) when needed.
 */
export function csvEscape(value: string): string {
  const safe = CSV_FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A single CSV line (no trailing newline) from raw cell strings. */
export function csvLine(cells: string[]): string {
  return cells.map(csvEscape).join(',');
}

/** One parsed CSV row: its cells and the 1-based line it starts on (quoted line breaks span lines). */
export interface CsvRow {
  line: number;
  cells: string[];
}

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/**
 * Parse RFC-4180 CSV text: `,` separators, `"` quoting with `""` escapes,
 * CRLF / LF / CR line ends, an optional UTF-8 BOM. Blank lines are skipped. A
 * stray quote inside an unquoted cell, text after a closing quote, or an
 * unterminated quoted cell is a CsvParseError naming the line. `maxRows`
 * (counting the header) stops the parse EARLY: the result then holds
 * `maxRows + 1` rows, so the caller can refuse "too many rows" without
 * parsing the rest.
 */
export function parseCsv(text: string, opts: { maxRows?: number } = {}): CsvRow[] {
  const max = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: CsvRow[] = [];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const n = text.length;
  while (i < n && rows.length <= max) {
    const start = line;
    const cells: string[] = [];
    let cell = '';
    let atCellStart = true;
    let endOfRow = false;
    while (i < n && !endOfRow) {
      const ch = text[i];
      if (atCellStart && ch === '"') {
        // A quoted cell: up to the closing quote ("" is a literal quote).
        i += 1;
        let closed = false;
        while (i < n) {
          const c = text[i];
          if (c === '"') {
            if (text[i + 1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            i += 1;
            closed = true;
            break;
          }
          if (c === '\r' || c === '\n') {
            if (c === '\r' && text[i + 1] === '\n') {
              cell += '\r\n';
              i += 2;
            } else {
              cell += c;
              i += 1;
            }
            line += 1;
            continue;
          }
          cell += c;
          i += 1;
        }
        if (!closed) throw new CsvParseError(`line ${start}: a quoted cell is never closed`, start);
        const next = text[i];
        if (i < n && next !== ',' && next !== '\r' && next !== '\n') {
          throw new CsvParseError(`line ${line}: unexpected text after a closing quote`, line);
        }
        atCellStart = false;
        continue;
      }
      if (ch === ',') {
        cells.push(cell);
        cell = '';
        atCellStart = true;
        i += 1;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
        line += 1;
        endOfRow = true;
        continue;
      }
      if (ch === '"') throw new CsvParseError(`line ${line}: a quote inside an unquoted cell (quote the whole cell and double the quote)`, line);
      cell += ch;
      atCellStart = false;
      i += 1;
    }
    cells.push(cell);
    if (cells.length === 1 && cells[0] === '') continue; // a blank line
    rows.push({ line: start, cells });
  }
  return rows;
}

/**
 * Undo `csvEscape`'s formula guard on a cell read back from a drobek export:
 * a leading `'` directly before `= + - @ tab CR` is dropped (`'-5` → `-5`).
 * Stored values are never spreadsheet cells; every export neutralizes again.
 */
export function csvUnguard(cell: string): string {
  return cell.length > 1 && cell[0] === "'" && CSV_FORMULA_TRIGGER.test(cell.slice(1)) ? cell.slice(1) : cell;
}
