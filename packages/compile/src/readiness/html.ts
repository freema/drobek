/**
 * The tags of an HTML page as the readiness checks read them: a pattern
 * scan of the text, never a browser parse and never executed. Comments and
 * the contents of `<script>`, `<style>`, `<template>`, `<title>` and
 * `<textarea>` are blanked first (line numbers kept), so markup quoted there
 * is not a tag.
 */

export interface HtmlTag {
  /** Lower-case tag name. */
  name: string;
  /** Lower-case attribute name → decoded value (an attribute without a value is ""); the first of a repeated name wins. */
  attrs: ReadonlyMap<string, string>;
  line: number;
}

export interface HtmlPage {
  /** Every start tag of the page, in order. */
  tags: HtmlTag[];
  /** The start tags of the document head: everything before `<body>` or `</head>` (the whole page when it has neither). */
  head: HtmlTag[];
  /** The line of `<head>`, else 1. */
  headLine: number;
}

const COMMENT = /<!--[\s\S]*?-->/g;
const RAW_TEXT = /(<(script|style|template|title|textarea)\b[^>]*>)([\s\S]*?)(<\/\2\s*>|$)/gi;
const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function readHtml(source: string): HtmlPage {
  const text = source.replace(COMMENT, blank).replace(RAW_TEXT, (_m, open: string, _name, body: string, close: string) => open + blank(body) + close);
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const lineAt = (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const headEnd = text.search(/<body\b|<\/head\s*>/i);
  const tags: HtmlTag[] = [];
  const head: HtmlTag[] = [];
  let headLine = 1;
  let seenHead = false;
  for (const m of text.matchAll(TAG)) {
    const attrs = new Map<string, string>();
    for (const a of m[2].matchAll(ATTR)) {
      const name = a[1].toLowerCase();
      if (!attrs.has(name)) attrs.set(name, decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
    }
    const tag: HtmlTag = { name: m[1].toLowerCase(), attrs, line: lineAt(m.index) };
    tags.push(tag);
    if (headEnd === -1 || m.index < headEnd) head.push(tag);
    if (tag.name === 'head' && !seenHead) {
      seenHead = true;
      headLine = tag.line;
    }
  }
  return { tags, head, headLine };
}

/** The space-separated tokens of an attribute (`rel="shortcut icon"` → ["shortcut", "icon"]), lower-case. */
export function tokensOf(value: string | undefined): string[] {
  return (value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}
