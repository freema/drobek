import { readHtml, tokensOf, type HtmlTag } from '../html.js';
import type { CheckFinding, ReadinessCheck } from '../types.js';

const PREVIEW_IMAGE = new Set(['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);
const MAX_QUOTED = 80;

function metaKey(tag: HtmlTag): string {
  return (tag.attrs.get('property') ?? tag.attrs.get('name') ?? '').trim().toLowerCase();
}

function isAbsoluteHttps(url: string): boolean {
  if (!/^https:\/\/[^/?#\s]/i.test(url)) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function quoted(value: string): string {
  return JSON.stringify(value.length > MAX_QUOTED ? `${value.slice(0, MAX_QUOTED)}…` : value);
}

function indexFindings(html: string, files: ReadonlyMap<string, unknown>): CheckFinding[] {
  const page = readHtml(html);
  const out: CheckFinding[] = [];

  const descriptions = page.head.filter((t) => t.name === 'meta' && (t.attrs.get('name') ?? '').trim().toLowerCase() === 'description');
  if (!descriptions.some((t) => (t.attrs.get('content') ?? '').trim().length > 0)) {
    out.push({
      code: 'missing_description',
      file: 'index.html',
      line: descriptions[0]?.line ?? page.headLine,
      message: `index.html has ${descriptions.length > 0 ? 'an empty' : 'no'} <meta name="description">: search results and link previews show text picked from the page, or none, instead of a sentence about what the app does.`,
    });
  }

  const linksIcon = page.head.some(
    (t) => t.name === 'link' && tokensOf(t.attrs.get('rel')).includes('icon') && (t.attrs.get('href') ?? '').trim().length > 0
  );
  if (!linksIcon && !files.has('favicon.ico')) {
    out.push({
      code: 'missing_favicon',
      file: 'index.html',
      line: page.headLine,
      message:
        'index.html has no <link rel="icon"> and the version has no favicon.ico: browser tabs and bookmarks show a generic icon, and the browser\'s request for /favicon.ico gets a 404. An uploaded favicon.ico counts only when index.html links it with <link rel="icon" href="/favicon.ico">.',
    });
  }
  return out;
}

function previewImageFindings(file: string, html: string): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const tag of readHtml(html).tags) {
    if (tag.name !== 'meta') continue;
    const key = metaKey(tag);
    if (!PREVIEW_IMAGE.has(key)) continue;
    const url = (tag.attrs.get('content') ?? '').trim();
    if (isAbsoluteHttps(url)) continue;
    const meta = `<meta ${tag.attrs.has('property') ? 'property' : 'name'}="${key}">`;
    out.push({
      code: 'og_image_not_absolute',
      file,
      line: tag.line,
      message: `${meta} ${url ? `is ${quoted(url)}, not an absolute https:// URL` : 'has no URL'}: social networks and chat apps load the preview image from the URL exactly as written, so the shared link shows no image.`,
    });
  }
  return out;
}

/**
 * How the app shows up outside its own page — `index.html` without a
 * description or a favicon, and any page whose link-preview image
 * (`og:image`, `twitter:image`) is not an absolute https URL.
 */
export const pageHead: ReadinessCheck = {
  id: 'page-head',
  codes: ['missing_description', 'missing_favicon', 'og_image_not_absolute'],
  run({ files }) {
    const out: CheckFinding[] = [];
    const index = files.get('index.html');
    if (typeof index === 'string') out.push(...indexFindings(index, files));
    for (const [path, content] of files) {
      if (typeof content === 'string' && path.toLowerCase().endsWith('.html')) out.push(...previewImageFindings(path, content));
    }
    return out;
  },
};
