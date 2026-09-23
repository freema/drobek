import { describe, expect, it } from 'vitest';
import { CsvParseError, csvEscape, csvLine, csvUnguard, parseCsv } from './csv.js';

describe('CSV serialization (RFC-4180 escaping)', () => {
  it('quotes fields containing quotes, commas or newlines and doubles quotes', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it('neutralizes spreadsheet formula injection with a leading quote (PHY-76 #5)', () => {
    // Leading =/+/-/@ triggers a formula in Excel/LibreOffice/Sheets.
    expect(csvEscape('=1+1')).toBe("'=1+1");
    expect(csvEscape('+1')).toBe("'+1");
    expect(csvEscape('-1')).toBe("'-1");
    expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
    // Leading tab is guarded ('); tab is not in the RFC quote-set so no wrap.
    expect(csvEscape('\t=1')).toBe("'\t=1");
    // Leading CR is guarded AND RFC-quoted (\r is in the quote-set).
    expect(csvEscape('\r=1')).toBe('"\'\r=1"');
    // A classic exfil / RCE payload is defanged AND RFC-quoted for its comma.
    expect(csvEscape('=HYPERLINK("http://evil","x")')).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
    // Non-leading triggers are untouched (only the FIRST char matters).
    expect(csvEscape('a=1')).toBe('a=1');
    expect(csvEscape('3-2')).toBe('3-2');
  });

  it('joins escaped cells into one line', () => {
    expect(csvLine(['a, b', 'false', '=1+1', ''])).toBe('"a, b",false,\'=1+1,');
  });
});

describe('CSV parsing (parseCsv)', () => {
  it('reads what csvLine writes: quotes, doubled quotes, commas and line breaks inside cells', () => {
    const cells = ['plain', 'a, b', 'he said "hi"', 'two\nlines', '', '=1+1'];
    const text = `${csvLine(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])}\r\n${csvLine(cells)}\r\n`;
    const rows = parseCsv(text);
    expect(rows).toHaveLength(2);
    expect(rows[1].cells.map(csvUnguard)).toEqual(cells);
  });

  it('reports the line each row starts on (a quoted break spans lines); skips blank lines and a BOM', () => {
    const rows = parseCsv('\ufeffa,b\n\n1,"x\ny"\n2,z\r\n');
    expect(rows).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 3, cells: ['1', 'x\ny'] },
      { line: 5, cells: ['2', 'z'] },
    ]);
  });

  it('refuses malformed quoting with the line number', () => {
    expect(() => parseCsv('a\n"open')).toThrow(CsvParseError);
    expect(() => parseCsv('a\nx"y')).toThrow(/line 2/);
    expect(() => parseCsv('a\n"x"y')).toThrow(/line 2/);
  });

  it('maxRows stops early with one row more than allowed', () => {
    const text = Array.from({ length: 50 }, (_, i) => `r${i}`).join('\n');
    expect(parseCsv(text, { maxRows: 10 })).toHaveLength(11);
    expect(parseCsv(text)).toHaveLength(50);
  });

  it("csvUnguard drops only the guard quote csvEscape adds", () => {
    expect(csvUnguard("'-5")).toBe('-5');
    expect(csvUnguard("'=x")).toBe('=x');
    expect(csvUnguard("'hello")).toBe("'hello");
    expect(csvUnguard("'")).toBe("'");
  });
});
