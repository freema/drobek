import type { CompileMessage, CompileWarningCode } from './types.js';

type HtmlToken =
  | { kind: 'text'; value: string; line: number }
  | { kind: 'start'; name: string; attrs: Map<string, string>; line: number; selfClosing: boolean }
  | { kind: 'end'; name: string; line: number };

interface CandidateName {
  text: string;
  explicit: boolean;
}

interface ElementNode {
  name: string;
  line: number;
  attrs: Map<string, string>;
  candidate?: CandidateName;
  titleText?: string;
}

interface ElementWarning {
  line: number;
  text: string;
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const ELEMENT_WARNING_LIMIT = 5;

/** Check basic document metadata and common accessibility omissions in static HTML. */
export function checkHtmlBasics(
  path: string,
  text: string,
  files: ReadonlySet<string>
): CompileMessage[] {
  if (!path.toLowerCase().endsWith('.html')) return [];

  const messages: CompileMessage[] = [];
  const stack: ElementNode[] = [];
  const elements: ElementNode[] = [];
  const controls: Array<{ tag: string; line: number; id: string; labelled: boolean; description: string }> = [];
  const explicitLabels = new Set<string>();
  let missingLangLine: number | undefined;
  let hasViewport = false;
  let hasIconLink = false;
  let firstTitle: ElementNode | undefined;

  for (const token of tokenizeHtml(text)) {
    if (token.kind === 'text') {
      if (!stack.some((node) => ['script', 'style', 'title', 'textarea'].includes(node.name))) {
        for (const node of stack) {
          if (node.candidate) node.candidate.text += token.value;
        }
      }
      for (const node of stack) {
        if (node.titleText !== undefined) node.titleText += token.value;
      }
      continue;
    }

    if (token.kind === 'end') {
      const match = findOpenElement(stack, token.name);
      if (match >= 0) stack.length = match;
      continue;
    }

    const { name, attrs, line } = token;
    if (name === 'html' && missingLangLine === undefined && !hasNonEmptyAttr(attrs, 'lang')) {
      missingLangLine = line;
    }
    if (name === 'meta' && attrs.get('name')?.trim().toLowerCase() === 'viewport') hasViewport = true;
    if (name === 'link' && attrs.get('rel')?.toLowerCase().split(/\s+/).includes('icon')) hasIconLink = true;
    if (name === 'label') {
      const target = attrs.get('for')?.trim();
      if (target) explicitLabels.add(target);
    }
    if (name === 'input' || name === 'select' || name === 'textarea') {
      const type = attrs.get('type')?.trim().toLowerCase();
      if (name !== 'input' || !['hidden', 'submit', 'button', 'reset'].includes(type ?? '')) {
        controls.push({
          tag: name,
          line,
          id: attrs.get('id')?.trim() ?? '',
          labelled: hasNonEmptyAttr(attrs, 'aria-label') || hasNonEmptyAttr(attrs, 'aria-labelledby') ||
            stack.some((node) => node.name === 'label'),
          description: name === 'input' ? `input${type ? ` type="${type}"` : ''}` : name,
        });
      }
    }
    const node: ElementNode = { name, line, attrs };
    if (name === 'title' && firstTitle === undefined) {
      node.titleText = '';
      firstTitle = node;
    }
    if (name === 'button' || (name === 'a' && attrs.has('href'))) {
      node.candidate = {
        text: '',
        explicit: hasNonEmptyAttr(attrs, 'aria-label') || hasNonEmptyAttr(attrs, 'aria-labelledby') ||
          hasNonEmptyAttr(attrs, 'title'),
      };
    }
    elements.push(node);

    if (name === 'img' && hasNonEmptyAttr(attrs, 'alt')) {
      for (const ancestor of stack) {
        if (ancestor.candidate) ancestor.candidate.text += attrs.get('alt');
      }
    }
    if (!token.selfClosing && !VOID_ELEMENTS.has(name)) stack.push(node);
  }

  const fileNames = [...files].map((file) => file.split('/').at(-1)?.toLowerCase());
  const hasFaviconFile = fileNames.some((file) => file === 'favicon.ico' || file === 'favicon.svg');
  if (missingLangLine !== undefined) {
    addPageWarning('html_missing_lang', missingLangLine, 'Add a lang attribute to the <html> element, for example lang="en".');
  }
  if (!hasViewport) {
    addPageWarning('html_missing_viewport', undefined, 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> inside <head>.');
  }
  if (!firstTitle || !hasMeaningfulText(firstTitle.titleText ?? '')) {
    addPageWarning('html_missing_title', firstTitle?.line, 'Add a non-empty <title> inside <head> so the app has a clear page and gallery title.');
  }
  if (!hasIconLink && !hasFaviconFile) {
    addPageWarning('missing_favicon', undefined, 'Add a <link rel="icon" href="/favicon.ico"> or include favicon.ico/favicon.svg in the app files.');
  }

  const imageWarnings = elements
    .filter((node) => node.name === 'img' && !node.attrs.has('alt'))
    .map((node) => ({ line: node.line, text: 'Add an alt attribute; use alt="" when the image is decorative.' }));
  appendElementWarnings(messages, path, 'a11y_img_alt', imageWarnings, 'images without alt text');

  const nameWarnings = elements
    .filter((node) => node.candidate && !node.candidate.explicit && !hasMeaningfulText(node.candidate.text))
    .map((node) => ({
      line: node.line,
      text: `Give this <${node.name}> an accessible name using text, aria-label, aria-labelledby, title, or an image with alt text.`,
    }));
  appendElementWarnings(messages, path, 'a11y_name', nameWarnings, 'buttons or links without an accessible name');

  const labelWarnings = controls
    .filter((control) => !control.labelled && (!control.id || !explicitLabels.has(control.id)))
    .map((control) => ({
      line: control.line,
      text: `Associate this ${control.description} with a <label>, or add aria-label/aria-labelledby.`,
    }));
  appendElementWarnings(messages, path, 'a11y_label', labelWarnings, 'form controls without a label');

  return messages;

  function addPageWarning(code: CompileWarningCode, line: number | undefined, warningText: string): void {
    messages.push({ code, file: path, ...(line === undefined ? {} : { line }), text: warningText });
  }
}

function appendElementWarnings(
  messages: CompileMessage[],
  file: string,
  code: CompileWarningCode,
  warnings: ElementWarning[],
  description: string
): void {
  for (const warning of warnings.slice(0, ELEMENT_WARNING_LIMIT)) {
    messages.push({ code, file, line: warning.line, text: warning.text });
  }
  const remaining = warnings.length - ELEMENT_WARNING_LIMIT;
  if (remaining > 0) {
    messages.push({
      code,
      file,
      text: `${remaining} more ${description} need attention. Fix those elements by following the same guidance above.`,
    });
  }
}

function hasNonEmptyAttr(attrs: Map<string, string>, name: string): boolean {
  const value = attrs.get(name);
  return value !== undefined && hasMeaningfulText(value);
}

function hasMeaningfulText(value: string): boolean {
  return decodeWhitespaceReferences(value).trim().length > 0;
}

function decodeWhitespaceReferences(value: string): string {
  return value
    .replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (_match, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ' ';
    })
    .replace(/&(?:nbsp|newline|tab);/gi, ' ');
}

function findOpenElement(stack: ElementNode[], name: string): number {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index].name === name) return index;
  }
  return -1;
}

function tokenizeHtml(text: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let cursor = 0;
  let line = 1;
  let rawTextElement = '';

  const emitText = (end: number): void => {
    if (end > cursor) {
      const value = text.slice(cursor, end);
      tokens.push({ kind: 'text', value, line });
      line += countNewlines(value);
      cursor = end;
    }
  };

  while (cursor < text.length) {
    if (rawTextElement) {
      const closingTag = new RegExp(`<\\/\\s*${rawTextElement}\\b`, 'ig');
      closingTag.lastIndex = cursor;
      const match = closingTag.exec(text);
      if (!match) {
        emitText(text.length);
        break;
      }
      emitText(match.index);
      rawTextElement = '';
    }

    const opening = text.indexOf('<', cursor);
    if (opening < 0) {
      emitText(text.length);
      break;
    }
    emitText(opening);

    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor + 4);
      const next = end < 0 ? text.length : end + 3;
      line += countNewlines(text.slice(cursor, next));
      cursor = next;
      continue;
    }

    const nextCharacter = text[cursor + 1];
    if (nextCharacter !== '/' && nextCharacter !== '!' && nextCharacter !== '?' && !/[a-z]/i.test(nextCharacter ?? '')) {
      emitText(cursor + 1);
      continue;
    }
    const tagEnd = findTagEnd(text, cursor + 1);
    if (tagEnd < 0) {
      emitText(cursor + 1);
      continue;
    }
    const raw = text.slice(cursor + 1, tagEnd);
    const tokenLine = line;
    const consumed = text.slice(cursor, tagEnd + 1);
    line += countNewlines(consumed);
    cursor = tagEnd + 1;

    if (/^\s*[!?]/.test(raw)) continue;
    const endTag = raw.match(/^\s*\/\s*([^\s/>]+)/);
    if (endTag) {
      tokens.push({ kind: 'end', name: endTag[1].toLowerCase(), line: tokenLine });
      continue;
    }
    const startTag = raw.match(/^\s*([^\s/>]+)/);
    if (!startTag) {
      tokens.push({ kind: 'text', value: consumed, line: tokenLine });
      continue;
    }
    const name = startTag[1].toLowerCase();
    const attrStart = startTag.index! + startTag[0].length;
    const attrs = parseAttributes(raw.slice(attrStart));
    const selfClosing = /\/\s*$/.test(raw);
    tokens.push({ kind: 'start', name, attrs, line: tokenLine, selfClosing });
    if (!selfClosing && ['script', 'style', 'title', 'textarea'].includes(name)) rawTextElement = name;
  }

  return tokens;
}

function findTagEnd(text: string, start: number): number {
  let quote = '';
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let cursor = 0;
  while (cursor < raw.length) {
    while (/\s/.test(raw[cursor] ?? '') || raw[cursor] === '/') cursor++;
    if (cursor >= raw.length) break;
    const start = cursor;
    while (cursor < raw.length && !/[\s=/>]/.test(raw[cursor])) cursor++;
    if (cursor === start) {
      cursor++;
      continue;
    }
    const name = raw.slice(start, cursor).toLowerCase();
    while (/\s/.test(raw[cursor] ?? '')) cursor++;
    let value = '';
    if (raw[cursor] === '=') {
      cursor++;
      while (/\s/.test(raw[cursor] ?? '')) cursor++;
      const quote = raw[cursor] === '"' || raw[cursor] === "'" ? raw[cursor++] : '';
      const valueStart = cursor;
      if (quote) {
        while (cursor < raw.length && raw[cursor] !== quote) cursor++;
        value = raw.slice(valueStart, cursor);
        if (raw[cursor] === quote) cursor++;
      } else {
        while (cursor < raw.length && !/[\s>]/.test(raw[cursor])) cursor++;
        value = raw.slice(valueStart, cursor).replace(/\/$/, '');
      }
    }
    if (!attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}

function countNewlines(value: string): number {
  return (value.match(/\r\n|\r|\n/g) ?? []).length;
}