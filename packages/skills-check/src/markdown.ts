/**
 * A tiny Markdown reader for the skills: fenced code blocks (with their info
 * string) and `##` headings. Skills are plain CommonMark written by us, so a
 * line scanner is enough — no dependency.
 */

export interface CodeBlock {
  /** First word of the info string (`tsx`, `json`, `html`, …); '' when none. */
  lang: string;
  /** The rest of the info string (`api`, `drobek.json`, …). */
  meta: string;
  code: string;
  /** 1-based line of the opening fence. */
  line: number;
  /** 0-based index among the file's code blocks. */
  index: number;
  /** The `##` heading the block sits under ('' before the first). */
  section: string;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)\s*(.*)$/;

export function codeBlocks(markdown: string): CodeBlock[] {
  const lines = markdown.split('\n');
  const out: CodeBlock[] = [];
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{2})\s+(.*)$/.exec(lines[i]);
    if (heading) {
      section = heading[2].trim();
      continue;
    }
    const open = FENCE_RE.exec(lines[i]);
    if (!open) continue;
    const [, indent, fence, lang, meta] = open;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = lines[j].trimStart();
      if (close.startsWith(fence) && close.slice(fence.length).trim() === '' && close[0] === fence[0]) break;
      body.push(indent && lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
    }
    out.push({ lang: lang.toLowerCase(), meta: meta.trim(), code: body.join('\n') + '\n', line: i + 1, index: out.length, section });
    i = j;
  }
  return out;
}

/** Every ATX heading outside code blocks. */
export function headings(markdown: string): Heading[] {
  const out: Heading[] = [];
  let inFence: string | null = null;
  markdown.split('\n').forEach((line, i) => {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (inFence === null) inFence = fence[2][0];
      else if (fence[2][0] === inFence && fence[3] === '') inFence = null;
      return;
    }
    if (inFence !== null) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
  });
  return out;
}

/** The text between the `##` heading that starts with `prefix` and the next `##` (fences included). */
export function sectionText(markdown: string, prefix: string): string {
  const lines = markdown.split('\n');
  const hs = headings(markdown).filter((h) => h.level === 2);
  const idx = hs.findIndex((h) => h.text.startsWith(prefix));
  if (idx < 0) return '';
  const end = idx + 1 < hs.length ? hs[idx + 1].line - 1 : lines.length;
  return lines.slice(hs[idx].line, end).join('\n');
}

/** The markdown without its fenced code blocks (the prose an agent reads). */
export function proseOf(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (m) {
      if (fence === null) fence = m[2][0];
      else if (m[2][0] === fence && m[3] === '') fence = null;
      continue;
    }
    if (fence === null) out.push(line);
  }
  return out.join('\n');
}
