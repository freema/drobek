import { blank, elements, replaceSpans, startTagReader } from '../markup.js';

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

const RAW_TEXT = ['script', 'style', 'template', 'title', 'textarea'];

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function readHtml(source: string): HtmlPage {
  const uncommented = replaceSpans(source, '<!--', '-->', blank);
  let text = '';
  let from = 0;
  for (const el of elements(uncommented, RAW_TEXT)) {
    text += uncommented.slice(from, el.contentStart) + blank(uncommented.slice(el.contentStart, el.contentEnd));
    from = el.contentEnd;
  }
  text += uncommented.slice(from);
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
  const nextTag = startTagReader(text);
  for (let t = nextTag(0); t; t = nextTag(t.end)) {
    const attrs = new Map<string, string>();
    for (const a of t.attrs) {
      const name = a.name.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, decodeEntities(a.value ?? ''));
    }
    const tag: HtmlTag = { name: t.name.toLowerCase(), attrs, line: lineAt(t.start) };
    tags.push(tag);
    if (headEnd === -1 || t.start < headEnd) head.push(tag);
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
