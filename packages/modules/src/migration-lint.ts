/**
 * Start-time lint of an EXTERNAL module's migrations (NSO-345; modules loaded
 * from `DROBEK_MODULES_DIR`, never the built-ins). A module runs in-process
 * with the whole database at hand, so this is not a sandbox — it keeps a
 * third-party module's SCHEMA in its own namespace, where the trust model
 * (docs/SECURITY.md) promises it stays:
 *
 *   - `CREATE TABLE` / `CREATE INDEX … ON` / `CREATE VIEW|SEQUENCE|TYPE` only
 *     for `mod_<name>` or `mod_<name>_*`;
 *   - `REFERENCES` only to its own tables, `apps(id)` or `workspaces(id)`;
 *   - `ALTER` / `DROP` (table, index, view, sequence, type) and `TRUNCATE`
 *     only of its own objects;
 *   - no `CREATE FUNCTION|PROCEDURE|TRIGGER|EXTENSION|RULE|SCHEMA|ROLE|…`,
 *     no `ALTER|DROP` of anything else (schemas, roles, functions, …), no
 *     `GRANT` / `REVOKE`, no `COPY`.
 *
 * Names may be quoted and qualified with `public.` (as drizzle-kit writes
 * them); any other schema is refused. Comments, string literals and dollar-
 * quoted bodies are blanked before the scan (line numbers kept), so a
 * statement inside a `DO $$ … $$` block is scanned like any other.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationLintIssue {
  file: string;
  line: number;
  message: string;
}

/** Blank comments + quoted literals (keeping newlines and length), leave identifiers. */
function blank(sql: string): string {
  const out = sql.split('');
  const wipe = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      wipe(i, stop);
      i = stop;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      wipe(i, stop);
      i = stop;
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      wipe(i, Math.min(j + 1, sql.length));
      i = j + 1;
    } else if (c === '"') {
      // A quoted identifier: keep it (the rules read names).
      const end = sql.indexOf('"', i + 1);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        // A dollar-quoted body: DO $$ … $$ holds SQL (scan it), a function
        // body would too — only the delimiters are blanked.
        wipe(i, i + tag[0].length);
        i += tag[0].length;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;

/** `"public"."mod_x"` → { schema: 'public', name: 'mod_x' }. */
function splitName(raw: string): { schema: string | null; name: string } {
  const parts = raw.match(new RegExp(IDENT, 'g')) ?? [];
  const unq = (p: string) => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toLowerCase());
  return parts.length === 2 ? { schema: unq(parts[0]), name: unq(parts[1]) } : { schema: null, name: unq(parts[0] ?? '') };
}

interface Rule {
  re: RegExp;
  check: (m: RegExpExecArray) => string | null;
}

/**
 * Every violation in one migration's SQL (empty = clean). `name` is the
 * module's name; `file` only labels the issues.
 */
export function lintMigrationSql(name: string, sql: string, file = 'migration.sql'): MigrationLintIssue[] {
  const text = blank(sql);
  const prefix = `mod_${name}`;
  /** null when `raw` names one of the module's own objects, else why not. */
  const own = (raw: string): string | null => {
    const { schema, name: n } = splitName(raw);
    if (schema !== null && schema !== 'public') return `${raw.trim()} is outside the public schema`;
    return n === prefix || n.startsWith(`${prefix}_`) ? null : `${raw.trim()} is not a table of this module (${prefix} or ${prefix}_*)`;
  };
  const lineAt = (index: number) => text.slice(0, index).split('\n').length;
  const O = String.raw`(?:\s+(?:IF\s+NOT\s+EXISTS|IF\s+EXISTS|ONLY|CONCURRENTLY))*`;
  const rules: Rule[] = [
    {
      re: new RegExp(String.raw`\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE${O}\s+(${QNAME})`, 'dgi'),
      check: (m) => own(m[1]),
    },
    {
      re: new RegExp(String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX${O}(?:\s+(?!ON\b)${IDENT})?\s+ON${O}\s+(${QNAME})`, 'dgi'),
      check: (m) => own(m[1]),
    },
    {
      re: new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP(?:ORARY)?|RECURSIVE|MATERIALIZED)\s+)*(VIEW|SEQUENCE|TYPE)${O}\s+(${QNAME})`, 'dgi'),
      check: (m) => own(m[2]),
    },
    {
      re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+|EVENT\s+)?(FUNCTION|PROCEDURE|TRIGGER|EXTENSION|RULE|SCHEMA|ROLE|USER|DATABASE|POLICY|AGGREGATE|OPERATOR|CAST|DOMAIN|LANGUAGE|PUBLICATION|SUBSCRIPTION|SERVER|TABLESPACE|FOREIGN|TRANSFORM|CONVERSION|COLLATION|STATISTICS|ACCESS)\b/dgi,
      check: (m) => `CREATE ${m[1].toUpperCase()} is not allowed in a module migration`,
    },
    {
      re: new RegExp(String.raw`\b(ALTER|DROP)\s+(TABLE|INDEX|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE)${O}\s+(${QNAME}(?:\s*,\s*${QNAME})*)`, 'dgi'),
      check: (m) => {
        for (const raw of m[3].match(new RegExp(QNAME, 'g')) ?? []) {
          const why = own(raw);
          if (why) return `${m[1].toUpperCase()} ${m[2].toUpperCase().replace(/\s+/g, ' ')}: ${why}`;
        }
        return null;
      },
    },
    {
      // At a statement start only (`ALTER TABLE t ALTER c …` is a clause).
      re: /(?:^|;|\b(?:BEGIN|THEN|ELSE|LOOP|DO)\b)\s*(ALTER|DROP)\s+(?!TABLE\b|INDEX\b|VIEW\b|MATERIALIZED\s+VIEW\b|SEQUENCE\b|TYPE\b)(EVENT\s+TRIGGER|DEFAULT\s+PRIVILEGES|FOREIGN\s+(?:TABLE|DATA\s+WRAPPER)|TEXT\s+SEARCH|[A-Z]+)/dgi,
      check: (m) => `${m[1].toUpperCase()} ${m[2].toUpperCase().replace(/\s+/g, ' ')} is not allowed in a module migration`,
    },
    {
      re: new RegExp(String.raw`\bTRUNCATE(?:\s+TABLE)?${O}\s+(${QNAME}(?:\s*,\s*${QNAME})*)`, 'dgi'),
      check: (m) => {
        for (const raw of m[1].match(new RegExp(QNAME, 'g')) ?? []) {
          const why = own(raw);
          if (why) return `TRUNCATE: ${why}`;
        }
        return null;
      },
    },
    {
      re: new RegExp(String.raw`\bREFERENCES\s+(${QNAME})(?:\s*\(\s*(${IDENT})\s*\))?`, 'dgi'),
      check: (m) => {
        const target = splitName(m[1]);
        const col = m[2] ? splitName(m[2]).name : null;
        if (target.schema !== null && target.schema !== 'public') return `REFERENCES ${m[1].trim()} is outside the public schema`;
        if ((target.name === 'apps' || target.name === 'workspaces') && (col === 'id' || col === null)) return null;
        if (own(m[1]) === null) return null;
        return `REFERENCES ${m[1].trim()}${m[2] ? `(${m[2]})` : ''}: a module may reference only its own tables, apps(id) or workspaces(id)`;
      },
    },
    {
      re: /\b(GRANT|REVOKE|COPY|SECURITY\s+LABEL|COMMENT\s+ON\s+(?:SCHEMA|DATABASE|ROLE|EXTENSION))\b/dgi,
      check: (m) => `${m[1].toUpperCase().replace(/\s+/g, ' ')} is not allowed in a module migration`,
    },
  ];
  const issues: MigrationLintIssue[] = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const message = rule.check(m);
      if (message) issues.push({ file, line: lineAt(m.indices?.[1]?.[0] ?? m.index), message });
    }
  }
  return issues.sort((a, b) => a.line - b.line);
}

/** Lint every `*.sql` of a module's migrations folder (sorted by file name). */
export function lintModuleMigrations(name: string, folder: string): MigrationLintIssue[] {
  if (!existsSync(folder)) return [];
  const files = readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.flatMap((f) => lintMigrationSql(name, readFileSync(join(folder, f), 'utf8'), f));
}
