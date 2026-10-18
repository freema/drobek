/**
 * The feedback widget of the preview and version hosts — platform code
 * served by drobek, never app code.
 *
 * Every HTML file a preview (`<slug>--preview`) or version (`<slug>--v<N>`)
 * host serves gets ONE tag before its `</body>`:
 *
 *   <script src="/__drobek/feedback.js" defer data-app="<slug>" data-version="<N>"></script>
 *
 * (`script-src 'self'` of the app CSP covers it). The production host and
 * custom domains never get it, and a version whose drobek.json says
 * `"feedback": false` does not either. The script draws a "Feedback" button
 * in a closed shadow root, in the platform theme's colours (copied into the
 * script, light and dark). A click starts picking: an outline follows the
 * element under the pointer (or the focused one — Tab moves, Enter picks; on
 * a touch screen the first tap outlines, a second tap on the same element
 * picks) with a short description of it, Esc or the button ("Cancel") stops.
 * Picking opens the dashboard's `/feedback/new` page in a new window
 * (`noopener`, so neither page holds a handle on the other) with the app, the
 * version, the page path, the spot (document coordinates + viewport), a CSS
 * selector and the description of the element in the query. The note itself
 * is written and sent on the dashboard origin by a signed-in member of the
 * app's workspace: the app host carries no dashboard credential, and nothing
 * the app's JavaScript can read or forge on its origin sends a note.
 *
 * The widget is not drawn inside a frame (the dashboard's app thumbnails).
 */
import { createHash } from 'node:crypto';
import { PLATFORM_COLORS, PLATFORM_FONT, PLATFORM_SHADOW, type PlatformPalette } from '@drobek/core/platform-theme';

export const FEEDBACK_SCRIPT_PATH = '/__drobek/feedback.js';

/** Characters of the element description the widget sends (the server keeps at most FEEDBACK_LABEL_MAX). */
export const FEEDBACK_WIDGET_LABEL_MAX = 40;

/** The widget the handler serves and injects (absent from the deps → no widget anywhere). */
export interface FeedbackWidget {
  /** The script bytes (the dashboard origin built in). */
  script: Buffer;
  /** sha256 (16 hex) of `script` — part of the injected pages' ETag. */
  hash: string;
}

/** The widget for a dashboard origin (PUBLIC_APP_URL), or null without a valid http(s) origin. */
export function feedbackWidget(dashboardOrigin: string | null | undefined): FeedbackWidget | null {
  let origin: string;
  try {
    const url = new URL(String(dashboardOrigin ?? ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    origin = url.origin;
  } catch {
    return null;
  }
  const script = Buffer.from(feedbackWidgetSource(origin));
  return { script, hash: createHash('sha256').update(script).digest('hex').slice(0, 16) };
}

/** The tag injected into an HTML page served from version `versionNumber` of app `slug`. */
export function feedbackScriptTag(slug: string, versionNumber: number): string {
  const safeSlug = slug.replace(/[^a-z0-9-]/g, '');
  return `<script src="${FEEDBACK_SCRIPT_PATH}" defer data-app="${safeSlug}" data-version="${Math.trunc(versionNumber)}"></script>`;
}

/**
 * `html` with `tag` before its last `</body>` (any case), else before its
 * last `</html>`, else at the end. The rest of the bytes stay as they are.
 */
export function injectBeforeBodyEnd(html: Buffer, tag: string): Buffer {
  const text = html.toString('latin1');
  const lower = text.toLowerCase();
  let at = lower.lastIndexOf('</body');
  if (at < 0) at = lower.lastIndexOf('</html');
  const inject = Buffer.from(tag, 'utf8');
  if (at < 0) return Buffer.concat([html, inject]);
  return Buffer.concat([html.subarray(0, at), inject, html.subarray(at)]);
}

function themeVars(p: PlatformPalette): string {
  return `--surface:${p.surface};--ink:${p.ink};--muted:${p.muted};--line:${p.line};--accent:${p.accent};--accent-ink:${p.accentInk};--crumb:${p.crumb}`;
}

/** The shadow root's stylesheet: the platform theme's values, light and dark. */
function widgetCss(): string {
  return [
    `:host{${themeVars(PLATFORM_COLORS.light)}}`,
    `@media (prefers-color-scheme:dark){:host{${themeVars(PLATFORM_COLORS.dark)}}}`,
    `*{box-sizing:border-box;font:600 13px/1.3 ${PLATFORM_FONT}}`,
    'button{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--accent);border-radius:999px;padding:8px 14px 8px 11px;background:var(--accent);color:var(--accent-ink);cursor:pointer}',
    `.fab{box-shadow:${PLATFORM_SHADOW}}`,
    '.fab[aria-pressed="true"]{background:var(--surface);color:var(--ink);border-color:var(--line)}',
    'button:focus-visible{outline:2px solid var(--crumb);outline-offset:2px}',
    'button svg{flex:none}',
    'button.secondary{background:var(--surface);color:var(--ink);border-color:var(--line);padding:5px 10px;border-radius:8px;white-space:nowrap}',
    `.bar,.toast{display:none;position:fixed;right:16px;bottom:64px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:12px;padding:8px 12px;box-shadow:${PLATFORM_SHADOW};max-width:min(420px,calc(100vw - 32px))}`,
    '.bar{align-items:center;gap:10px}',
    '.bar span,.toast{font-weight:500}',
    '.bar.on{display:flex}',
    '.toast{max-width:min(300px,calc(100vw - 32px))}',
    '.toast.on{display:block}',
    '.hl{display:none;position:fixed;pointer-events:none;border:2px solid var(--crumb);border-radius:4px;background:rgba(217,154,78,.12);transition:left .06s,top .06s,width .06s,height .06s,background-color .12s}',
    '.hl.on{display:block}',
    '.hl.flash{background:rgba(217,154,78,.45)}',
    '.tag{display:none;position:fixed;pointer-events:none;max-width:calc(100vw - 8px);padding:3px 7px;border-radius:6px;background:var(--accent);color:var(--accent-ink);font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tag.on{display:block}',
    '@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}',
  ].join('');
}

const ICON_NOTE =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3h11v7.5h-6L4.5 13v-2.5h-2z"/><path d="M5.5 6h5M5.5 8h3"/></svg>';
const ICON_CANCEL =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';

/** The browser script (ES2017, no imports, no eval). */
function feedbackWidgetSource(dashboardOrigin: string): string {
  return `(function () {
  'use strict';
  var DASHBOARD = ${JSON.stringify(dashboardOrigin)};
  var LABEL_MAX = ${FEEDBACK_WIDGET_LABEL_MAX};
  var me = document.currentScript;
  try { if (window.top !== window.self) return; } catch (e) { return; }
  if (window.__drobekFeedback) return;
  window.__drobekFeedback = true;
  var app = (me && me.getAttribute('data-app')) || '';
  var version = (me && me.getAttribute('data-version')) || '';
  if (!app) return;

  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && parts.length < 6) {
      if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) { parts.unshift('#' + el.id); break; }
      var tag = el.tagName.toLowerCase();
      var parent = el.parentElement;
      if (parent) {
        var same = 0, index = 0;
        for (var i = 0; i < parent.children.length; i++) {
          var c = parent.children[i];
          if (c.tagName === el.tagName) { same++; if (c === el) index = same; }
        }
        if (same > 1) tag += ':nth-of-type(' + index + ')';
      }
      parts.unshift(tag);
      el = parent;
    }
    return parts.join(' > ').slice(0, 500);
  }

  function clip(text, max) {
    text = String(text || '').replace(/\\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, Math.max(max - 1, 1)) + '\\u2026' : text;
  }

  function describe(el) {
    var tag = el.tagName.toLowerCase();
    var name = tag;
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) name += '#' + el.id;
    else {
      var cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/)[0] : '';
      if (cls && /^[A-Za-z_-][\\w-]*$/.test(cls)) name += '.' + cls;
    }
    name = clip(name, 24);
    var room = Math.max(LABEL_MAX - name.length - 3, 8);
    if (tag === 'img') {
      var alt = el.getAttribute('alt');
      return alt ? name + ' alt="' + clip(alt, room - 4) + '"' : name;
    }
    var text = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (!text && /^(input|textarea|select)$/.test(tag)) text = el.getAttribute('placeholder') || el.getAttribute('name') || '';
    else if (!text) text = (el.textContent || '').slice(0, 200);
    text = clip(text, room);
    return text ? name + ' "' + text + '"' : name;
  }

  function open(spot) {
    var q = new URLSearchParams();
    q.set('app', app);
    if (version) q.set('v', version);
    q.set('path', location.pathname);
    if (spot) {
      q.set('x', String(Math.round(spot.x)));
      q.set('y', String(Math.round(spot.y)));
      q.set('vw', String(window.innerWidth));
      q.set('vh', String(window.innerHeight));
      if (spot.selector) q.set('sel', spot.selector);
      if (spot.label) q.set('label', spot.label);
    }
    window.open(DASHBOARD + '/feedback/new?' + q.toString(), '_blank', 'popup=yes,width=520,height=720,noopener,noreferrer');
    say('The note form opened in a new window. Sign in there if asked.');
  }

  var host = document.createElement('div');
  host.setAttribute('data-drobek-feedback', '');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
  var ICON_NOTE = ${JSON.stringify(ICON_NOTE)};
  var ICON_CANCEL = ${JSON.stringify(ICON_CANCEL)};
  root.innerHTML =
    '<style>' + ${JSON.stringify(widgetCss())} + '</style>' +
    '<div class="hl" aria-hidden="true"></div><div class="tag" aria-hidden="true"></div>' +
    '<div class="bar" role="status"><span>Click the spot your note is about, or Tab to it and press Enter. On a touch screen, tap it twice. Esc cancels.</span><button type="button" class="secondary" data-whole>Note on the whole page</button></div>' +
    '<div class="toast" role="status"></div>' +
    '<button type="button" class="fab" data-start aria-pressed="false" title="Leave a note for the people building this app"></button>';
  var hl = root.querySelector('.hl');
  var tagBox = root.querySelector('.tag');
  var bar = root.querySelector('.bar');
  var toast = root.querySelector('.toast');
  var start = root.querySelector('[data-start]');
  var timer = 0;

  function say(text) {
    toast.textContent = text;
    toast.className = 'toast on';
    clearTimeout(timer);
    timer = setTimeout(function () { toast.className = 'toast'; }, 5000);
  }

  var picking = false;
  var current = null;
  var currentBy = '';
  var pointerType = '';

  function drawButton() {
    start.innerHTML = picking ? ICON_CANCEL + '<span>Cancel</span>' : ICON_NOTE + '<span>Feedback</span>';
    start.setAttribute('aria-pressed', picking ? 'true' : 'false');
  }

  function hide() {
    current = null;
    currentBy = '';
    hl.className = 'hl';
    tagBox.className = 'tag';
  }

  function place() {
    if (!current) return;
    if (!current.isConnected) { hide(); return; }
    var r = current.getBoundingClientRect();
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
    var vw = window.innerWidth, vh = window.innerHeight;
    var h = tagBox.offsetHeight || 22;
    var top = r.top - h - 4;
    if (top < 4) top = r.bottom + 4;
    if (top > vh - h - 4) top = Math.max(r.top + 4, 4);
    tagBox.style.top = Math.min(Math.max(top, 4), Math.max(vh - h - 4, 4)) + 'px';
    tagBox.style.left = Math.max(4, Math.min(r.left, vw - tagBox.offsetWidth - 4)) + 'px';
  }

  function show(el, by) {
    current = el;
    currentBy = by;
    tagBox.textContent = describe(el);
    hl.className = 'hl on';
    tagBox.className = 'tag on';
    place();
  }

  function targetOf(e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    if (path.indexOf(host) >= 0) return null;
    var t = path[0] || e.target;
    while (t && t.nodeType !== 1) t = t.parentNode;
    return t && t !== document.documentElement ? t : null;
  }

  function focusables() {
    var all = document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[contenteditable=""],[contenteditable=true]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.disabled || el.getAttribute('tabindex') === '-1' || !el.getClientRects().length) continue;
      out.push(el);
    }
    return out;
  }

  function stop() {
    picking = false;
    hide();
    bar.className = 'bar';
    document.documentElement.style.cursor = '';
    window.removeEventListener('click', onPick, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('focusin', onFocus, true);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    drawButton();
  }

  function pick(el, x, y) {
    var spot = { x: x, y: y, selector: cssPath(el), label: describe(el) };
    show(el, currentBy);
    window.removeEventListener('click', onPick, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('focusin', onFocus, true);
    hl.className = 'hl on flash';
    setTimeout(function () { stop(); open(spot); }, 180);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); stop(); return; }
    var inWidget = (e.composedPath ? e.composedPath() : []).indexOf(host) >= 0;
    if (e.key === 'Tab' && document.activeElement === host) {
      var list = focusables();
      if (!list.length) return;
      e.preventDefault();
      list[e.shiftKey ? list.length - 1 : 0].focus();
      return;
    }
    if (e.key === 'Enter' && !inWidget && current && currentBy === 'focus') {
      e.preventDefault();
      e.stopPropagation();
      var r = current.getBoundingClientRect();
      pick(current, r.left + r.width / 2 + window.pageXOffset, r.top + r.height / 2 + window.pageYOffset);
    }
  }
  function onDown(e) { pointerType = e.pointerType || ''; }
  function onMove(e) {
    if (e.pointerType === 'touch') return;
    var t = targetOf(e);
    if (t && t !== current) show(t, 'pointer');
  }
  function onFocus(e) {
    var t = targetOf(e);
    if (t && t !== document.body) show(t, 'focus');
  }
  function onPick(e) {
    var path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(host) >= 0) return;
    e.preventDefault();
    e.stopPropagation();
    var t = targetOf(e);
    if (!t) return;
    if (pointerType === 'touch' && t !== current) { show(t, 'touch'); return; }
    pick(t, e.pageX, e.pageY);
  }

  start.addEventListener('click', function () {
    if (picking) { stop(); return; }
    picking = true;
    bar.className = 'bar on';
    drawButton();
    document.documentElement.style.cursor = 'crosshair';
    setTimeout(function () {
      if (!picking) return;
      window.addEventListener('click', onPick, true);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('pointermove', onMove, { capture: true, passive: true });
      window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
      document.addEventListener('focusin', onFocus, true);
      window.addEventListener('scroll', place, { capture: true, passive: true });
      window.addEventListener('resize', place);
    }, 0);
  });
  root.querySelector('[data-whole]').addEventListener('click', function () { stop(); open(null); });
  drawButton();

  function mount() { (document.body || document.documentElement).appendChild(host); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
`;
}
