import { elements, replaceSpans } from '../../markup.js';
import { readHtml, tokensOf, type HtmlPage, type HtmlTag } from '../html.js';
import type { CheckFinding, ReadinessCheck } from '../types.js';

/** Elements one rule lists per file; the rest are counted in one more finding. */
const ELEMENT_WARNING_LIMIT = 5;
const MAX_QUOTED = 60;

/** `<input>` types that need no label: not shown, or named by their `value` / `alt`. */
const UNLABELLED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const FORM_CONTROLS = new Set(['input', 'select', 'textarea']);

/** How Vue and Alpine templates bind an attribute (`:alt`, `v-bind:alt`, `x-bind:alt`) or an element's text in the browser. */
const ATTR_BINDINGS = [':', 'v-bind:', 'x-bind:'];
const TEXT_BINDINGS = ['v-text', 'v-html', 'x-text', 'x-html'];

function decodeWhitespaceReferences(value: string): string {
  return value
    .replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (_match, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ' ';
    })
    .replace(/&(?:nbsp|newline|tab);/gi, ' ');
}

/** More than white space, written literally or as a character reference (`&nbsp;`, `&#32;`). */
function hasMeaningfulText(value: string): boolean {
  return decodeWhitespaceReferences(value).trim().length > 0;
}

/** The attribute gets its value in the browser: the page cannot say it is missing. */
function isBound(tag: HtmlTag, name: string): boolean {
  return ATTR_BINDINGS.some((binding) => tag.attrs.has(binding + name));
}

function hasNonEmptyAttr(tag: HtmlTag, name: string): boolean {
  return hasMeaningfulText(tag.attrs.get(name) ?? '') || isBound(tag, name);
}

function hasAriaName(tag: HtmlTag): boolean {
  return hasNonEmptyAttr(tag, 'aria-label') || hasNonEmptyAttr(tag, 'aria-labelledby');
}

function isHiddenFromScreenReaders(tag: HtmlTag): boolean {
  return (tag.attrs.get('aria-hidden') ?? '').trim().toLowerCase() === 'true';
}

function hasBoundText(tag: HtmlTag): boolean {
  return TEXT_BINDINGS.some((binding) => tag.attrs.has(binding));
}

/** `<img src="/logo.png">`: the tag with the attributes of `names` it has, long values cut. */
function shown(tag: HtmlTag, names: readonly string[]): string {
  const attrs = names
    .filter((name) => (tag.attrs.get(name) ?? '').length > 0)
    .map((name) => {
      const value = tag.attrs.get(name)!;
      return ` ${name}=${JSON.stringify(value.length > MAX_QUOTED ? `${value.slice(0, MAX_QUOTED)}…` : value)}`;
    });
  return `<${tag.name}${attrs.join('')}>`;
}

/** `<img>` without `alt`. `alt=""` marks a decorative image; so do `role="presentation"` and `aria-hidden="true"`. */
function imagesWithoutAlt(page: HtmlPage): HtmlTag[] {
  return page.tags.filter(
    (tag) =>
      tag.name === 'img' &&
      !tag.attrs.has('alt') &&
      !isBound(tag, 'alt') &&
      !hasAriaName(tag) &&
      !isHiddenFromScreenReaders(tag) &&
      !tokensOf(tag.attrs.get('role')).some((role) => role === 'presentation' || role === 'none')
  );
}

/** A tag inside a button or a link that gives it a name: an image with alt text, an `aria-label`, a `title`, an SVG `<title>`. */
function namesItsParent(tag: HtmlTag): boolean {
  return tag.name === 'title' || hasNonEmptyAttr(tag, 'alt') || hasAriaName(tag) || hasNonEmptyAttr(tag, 'title') || hasBoundText(tag);
}

/**
 * `<button>` and `<a href>` elements with no accessible name: no text, no
 * `aria-label`, `aria-labelledby` or `title`, and nothing inside that has
 * one. An element without its end tag is left alone.
 */
function unnamedButtonsAndLinks(page: HtmlPage): HtmlTag[] {
  const tagAt = new Map(page.tags.map((tag) => [tag.start, tag]));
  const out: HtmlTag[] = [];
  let next = 0;
  for (const el of elements(page.text, ['a', 'button'])) {
    const tag = tagAt.get(el.start);
    if (!tag || tag.name !== el.name || !el.closed || el.contentEnd < tag.end) continue;
    if (tag.name === 'a' && !tag.attrs.has('href')) continue;
    if (isHiddenFromScreenReaders(tag) || hasAriaName(tag) || hasNonEmptyAttr(tag, 'title') || hasBoundText(tag)) continue;
    const content = page.text.slice(tag.end, el.contentEnd);
    if (hasMeaningfulText(replaceSpans(content, '<', '>', () => ''))) continue;
    while (next < page.tags.length && page.tags[next].start < tag.end) next++;
    let named = false;
    for (let i = next; !named && i < page.tags.length && page.tags[i].start < el.contentEnd; i++) named = namesItsParent(page.tags[i]);
    if (!named) out.push(tag);
  }
  return out;
}

/**
 * `<input>`, `<select>` and `<textarea>` without a label: no `<label for>`
 * with their id, no `<label>` around them, no `aria-label`,
 * `aria-labelledby` or `title`.
 */
function controlsWithoutLabel(page: HtmlPage): HtmlTag[] {
  const labelled = new Set<string>();
  for (const tag of page.tags) {
    const target = tag.name === 'label' ? (tag.attrs.get('for') ?? '').trim() : '';
    if (target) labelled.add(target);
  }
  const labels = elements(page.text, ['label']);
  let label = labels.next();
  const out: HtmlTag[] = [];
  for (const tag of page.tags) {
    if (!FORM_CONTROLS.has(tag.name)) continue;
    if (tag.name === 'input' && UNLABELLED_INPUT_TYPES.has((tag.attrs.get('type') ?? '').trim().toLowerCase())) continue;
    if (tag.attrs.has('hidden') || isHiddenFromScreenReaders(tag)) continue;
    if (hasAriaName(tag) || hasNonEmptyAttr(tag, 'title')) continue;
    if (labelled.has((tag.attrs.get('id') ?? '').trim()) || isBound(tag, 'id')) continue;
    while (!label.done && label.value.end <= tag.start) label = labels.next();
    if (!label.done && label.value.start < tag.start && tag.start < label.value.contentEnd) continue;
    out.push(tag);
  }
  return out;
}

/** The first `ELEMENT_WARNING_LIMIT` elements, each a finding at its line, then one finding that counts the rest. */
function elementFindings(
  file: string,
  code: string,
  tags: readonly HtmlTag[],
  message: (tag: HtmlTag) => string,
  rest: (count: number) => string
): CheckFinding[] {
  const out: CheckFinding[] = tags.slice(0, ELEMENT_WARNING_LIMIT).map((tag) => ({ code, file, line: tag.line, message: message(tag) }));
  const remaining = tags.length - ELEMENT_WARNING_LIMIT;
  if (remaining > 0) out.push({ code, file, line: tags[ELEMENT_WARNING_LIMIT].line, message: rest(remaining) });
  return out;
}

function pageFindings(file: string, html: string): CheckFinding[] {
  const page = readHtml(html);
  const out: CheckFinding[] = [];

  if (page.tags.some((tag) => tag.name === 'html' || tag.name === 'head')) {
    const root = page.tags.find((tag) => tag.name === 'html');
    if (!root || !hasNonEmptyAttr(root, 'lang')) {
      out.push({
        code: 'html_missing_lang',
        file,
        line: root?.line ?? 1,
        message: `${file} has no lang on its <html> element: screen readers read the page in the wrong language and browsers cannot offer a translation.`,
      });
    }
    const viewports = page.tags.filter((tag) => tag.name === 'meta' && (tag.attrs.get('name') ?? '').trim().toLowerCase() === 'viewport');
    if (!viewports.some((tag) => hasNonEmptyAttr(tag, 'content'))) {
      out.push({
        code: 'html_missing_viewport',
        file,
        line: viewports[0]?.line ?? page.headLine,
        message: `${file} has ${viewports.length > 0 ? 'an empty' : 'no'} <meta name="viewport">: phones lay the page out at desktop width and shrink it, so the text is tiny.`,
      });
    }
  }

  out.push(
    ...elementFindings(
      file,
      'a11y_img_alt',
      imagesWithoutAlt(page),
      (tag) => `${shown(tag, ['src'])} has no alt attribute: a screen reader reads out the file name instead of what the image shows.`,
      (count) => `${file} has ${count} more images without an alt attribute.`
    ),
    ...elementFindings(
      file,
      'a11y_name',
      unnamedButtonsAndLinks(page),
      (tag) =>
        `${shown(tag, ['href', 'id'])} has no accessible name (no text, aria-label or title, and no image with alt text inside): a screen reader announces only "${tag.name === 'a' ? 'link' : 'button'}".`,
      (count) => `${file} has ${count} more buttons or links without an accessible name.`
    ),
    ...elementFindings(
      file,
      'a11y_label',
      controlsWithoutLabel(page),
      (tag) =>
        `${shown(tag, ['type', 'id', 'name'])} has no label (no <label for>, no <label> around it, no aria-label or aria-labelledby): a screen reader does not say what the field is for. A placeholder is not a label.`,
      (count) => `${file} has ${count} more form fields without a label.`
    )
  );
  return out;
}

/**
 * The HTML and accessibility basics of every `.html` file of the version.
 * A full document (one with an `<html>` or `<head>` tag) needs a language
 * and a viewport; every file, a fragment too, is checked for images without
 * `alt`, buttons and links without an accessible name and form fields
 * without a label. Only the markup as written is read: what a script adds
 * in the browser is not seen.
 */
export const htmlBasics: ReadinessCheck = {
  id: 'html-basics',
  codes: ['html_missing_lang', 'html_missing_viewport', 'a11y_img_alt', 'a11y_name', 'a11y_label'],
  run({ files }) {
    const out: CheckFinding[] = [];
    for (const [path, content] of files) {
      if (typeof content === 'string' && path.toLowerCase().endsWith('.html')) out.push(...pageFindings(path, content));
    }
    return out;
  },
};
