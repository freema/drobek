import type { ReadinessCheck } from '../types.js';

const COMMENT = /<!--[\s\S]*?-->/g;
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** `index.html` without a non-empty `<title>` in its head (an inline SVG's title in the body does not count). */
export const missingTitle: ReadinessCheck = {
  id: 'missing-title',
  codes: ['missing_title'],
  run({ files }) {
    const html = files.get('index.html');
    if (typeof html !== 'string') return [];
    const text = html.replace(COMMENT, (c) => c.replace(/[^\n]/g, ' '));
    const headEnd = text.search(/<body\b|<\/head\s*>/i);
    const head = headEnd === -1 ? text : text.slice(0, headEnd);
    const title = TITLE.exec(head);
    if (title && title[1].replace(/<[^>]*>/g, '').trim().length > 0) return [];
    const headAt = text.search(/<head\b/i);
    return [
      {
        code: 'missing_title',
        file: 'index.html',
        line: title ? lineOf(text, title.index) : headAt === -1 ? 1 : lineOf(text, headAt),
        message: title
          ? 'index.html has an empty <title>: browser tabs, bookmarks and shared links show the bare address.'
          : 'index.html has no <title>: browser tabs, bookmarks and shared links show the bare address.',
      },
    ];
  },
};
