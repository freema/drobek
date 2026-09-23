/**
 * RFC-4180 CSV cells with spreadsheet formula-injection neutralization
 * (PHY-76 #5) — the ONE CSV writer of drobek: the data module's export, the
 * forms submissions export, the dashboard's Data tab and Activity exports all
 * serialize every cell through `csvLine`.
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
