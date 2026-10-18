/**
 * The preview script of the preview and version hosts — platform code served
 * by drobek, never app code.
 *
 * An HTML file the preview host (`<slug>--preview`) serves gets ONE tag
 * before its `</body>` (before the feedback widget's tag):
 *
 *   <script src="/__drobek/preview.js" defer data-app="<slug>" data-version="<N>" data-reload></script>
 *
 * (`script-src 'self'` of the app CSP covers it). `data-reload` is set unless
 * the version's drobek.json says `"reload": false`; a page with no part
 * switched on gets no tag. The production host and custom domains never get
 * it.
 *
 * With `data-reload` the script opens an `EventSource` on its own origin
 * (`/__drobek/preview/events`, `connect-src 'self'`). Every message is one
 * JSON object typed by its `type` field, handled by the entry of `handlers`
 * of that name (an unknown type is ignored):
 *
 *   { type: 'ready', version }                  the newest compiled version when the stream opened
 *   { type: 'version', version, compiled, errors }  a new version was stored
 *
 * A newer version that compiled reloads the page (the scroll position kept in
 * sessionStorage for the reloaded page); one that did not compile shows a
 * notice instead and the page stays as it is. A stream that cannot open
 * (limits, a proxy) changes nothing. The script reads no cookie, sets none,
 * and does nothing inside a frame (the dashboard's app thumbnails). Its one
 * piece of UI is `notice()`: a closed shadow root at the bottom left, styled
 * in place (no shared stylesheet).
 */
import { createHash } from 'node:crypto';

export const PREVIEW_SCRIPT_PATH = '/__drobek/preview.js';
/** The event stream of the preview host. */
export const PREVIEW_EVENTS_PATH = '/__drobek/preview/events';
/** Paths only the preview and version hosts answer (the production hosts answer 404). */
export const PREVIEW_PATH_PREFIX = '/__drobek/preview/';

/** The script the handler serves and injects (absent from the deps → no script anywhere). */
export interface PreviewScript {
  script: Buffer;
  /** sha256 (16 hex) of `script` — part of the injected pages' ETag. */
  hash: string;
}

/** Which parts of the script a page runs. */
export interface PreviewScriptParts {
  /** Reload after a write that compiled; a notice after one that did not (preview host only). */
  reload: boolean;
}

export function previewScript(): PreviewScript {
  const script = Buffer.from(PREVIEW_SCRIPT_SOURCE);
  return { script, hash: createHash('sha256').update(script).digest('hex').slice(0, 16) };
}

/** The ETag marker of a page carrying the tag of `parts` (`r` = reload). */
export function previewPartsKey(parts: PreviewScriptParts): string {
  return parts.reload ? 'r' : '';
}

/** The tag injected into an HTML page served from version `versionNumber` of app `slug`; null when no part is on. */
export function previewScriptTag(slug: string, versionNumber: number, parts: PreviewScriptParts): string | null {
  if (!parts.reload) return null;
  const safeSlug = slug.replace(/[^a-z0-9-]/g, '');
  return `<script src="${PREVIEW_SCRIPT_PATH}" defer data-app="${safeSlug}" data-version="${Math.trunc(versionNumber)}" data-reload></script>`;
}

/** The browser script (ES2017, no imports, no eval). */
const PREVIEW_SCRIPT_SOURCE = `(function () {
  'use strict';
  var me = document.currentScript;
  try { if (window.top !== window.self) return; } catch (e) { return; }
  if (window.__drobekPreview) return;
  window.__drobekPreview = true;
  var version = Number((me && me.getAttribute('data-version')) || 0);
  var reload = !!(me && me.hasAttribute('data-reload'));
  var EVENTS = ${JSON.stringify(PREVIEW_EVENTS_PATH)};
  var SCROLL_KEY = 'drobek:preview-scroll';

  var ui = null;
  function notice() {
    if (ui) return ui;
    var host = document.createElement('div');
    host.setAttribute('data-drobek-preview', '');
    host.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
    root.innerHTML =
      '<style>' +
      ':host,*{box-sizing:border-box;font:500 13px/1.4 system-ui,-apple-system,sans-serif}' +
      '.toast{display:none;max-width:min(420px,calc(100vw - 32px));background:#1a1a1a;color:#fff;border-radius:10px;padding:8px 12px;box-shadow:0 2px 10px rgba(0,0,0,.25)}' +
      '.toast.on{display:block}' +
      '@media (prefers-reduced-motion: no-preference){.toast.on{animation:drobek-in .18s ease-out}}' +
      '@keyframes drobek-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
      '</style>' +
      '<div class="toast" role="status" aria-live="polite"></div>';
    var toast = root.querySelector('.toast');
    (document.body || document.documentElement).appendChild(host);
    ui = {
      show: function (kind, text) {
        host.setAttribute('data-notice', kind);
        toast.textContent = text;
        toast.className = 'toast on';
      },
      hide: function () {
        host.removeAttribute('data-notice');
        toast.className = 'toast';
      }
    };
    return ui;
  }

  function keepScroll() {
    try {
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ path: location.pathname + location.search, x: window.scrollX, y: window.scrollY }));
    } catch (e) { /* storage off: the reload starts at the top */ }
  }
  function restoreScroll() {
    var saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null');
      sessionStorage.removeItem(SCROLL_KEY);
    } catch (e) { return; }
    if (!saved || saved.path !== location.pathname + location.search) return;
    var go = function () { window.scrollTo(Number(saved.x) || 0, Number(saved.y) || 0); };
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
    setTimeout(go, 300);
  }

  var handlers = {
    ready: function (m) {
      if (Number(m.version) > version) { keepScroll(); location.reload(); }
    },
    version: function (m) {
      var n = Number(m.version);
      if (!(n > version)) return;
      if (m.compiled === true) {
        keepScroll();
        location.reload();
        return;
      }
      notice().show('compile-failed', 'Version ' + n + ' did not compile \\u2014 your agent has the errors.');
    }
  };

  function listen() {
    if (typeof EventSource !== 'function') return;
    var es;
    try { es = new EventSource(EVENTS); } catch (e) { return; }
    es.onmessage = function (e) {
      var m = null;
      try { m = JSON.parse(e.data); } catch (x) { return; }
      if (!m || typeof m.type !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, m.type)) return;
      try { handlers[m.type](m); } catch (x) { /* one bad message never stops the stream */ }
    };
  }

  if (reload) {
    restoreScroll();
    listen();
  }
})();
`;
