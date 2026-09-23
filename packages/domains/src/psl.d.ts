// psl 1.15 ships types, but its package.json `exports` does not point at
// them (TS7016 under NodeNext) — declare the one function @drobek/domains uses.
declare module 'psl' {
  export interface ParsedDomain {
    input: string;
    tld: string | null;
    sld: string | null;
    domain: string | null;
    subdomain: string | null;
    listed: boolean;
  }
  export interface ParseError {
    input: string;
    error: { code: string; message: string };
  }
  export function parse(input: string): ParsedDomain | ParseError;
}
