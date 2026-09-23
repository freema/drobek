import { describe, expect, it } from 'vitest';
import { csvEscape, csvLine } from './csv.js';

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
