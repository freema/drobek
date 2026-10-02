import { blank, elements, replaceSpans } from '../../markup.js';
import type { ReadinessCheck } from '../types.js';

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
    const text = replaceSpans(html, '<!--', '-->', blank);
    const headEnd = text.search(/<body\b|<\/head\s*>/i);
    const head = headEnd === -1 ? text : text.slice(0, headEnd);
    const first = elements(head, ['title']).next();
    const title = first.done || !first.value.closed ? null : first.value;
    if (title && replaceSpans(head.slice(title.contentStart, title.contentEnd), '<', '>', () => '').trim().length > 0) return [];
    const headAt = text.search(/<head\b/i);
    return [
      {
        code: 'missing_title',
        file: 'index.html',
        line: title ? lineOf(text, title.start) : headAt === -1 ? 1 : lineOf(text, headAt),
        message: title
          ? 'index.html has an empty <title>: browser tabs, bookmarks and shared links show the bare address.'
          : 'index.html has no <title>: browser tabs, bookmarks and shared links show the bare address.',
      },
    ];
  },
};
