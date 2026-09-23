import type { CompileMessage } from './types.js';

/**
 * Credential patterns refused in app source (plan §4 step 2). Apps are public
 * static bundles — a key in source is a leaked key. Secrets belong in the
 * dashboard (module config / proxy upstreams), never in files.
 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'API key (sk-…)', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: 'hard-coded credential',
    re: /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"`][A-Za-z0-9_\-]{20,}['"`]/i,
  },
];

/** Scan one text file; reports the first match per line, never the value. */
export function scanForSecrets(file: string, text: string): CompileMessage[] {
  const found: CompileMessage[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of PATTERNS) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      found.push({
        code: 'secret_in_source',
        file,
        line: i + 1,
        column: m.index,
        text: `${name} found in source. Remove it: secrets are set by the app owner in the drobek dashboard and used server-side (proxy/module config), never shipped in app files.`,
      });
      break;
    }
  }
  return found;
}
