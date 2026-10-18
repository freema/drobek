/**
 * The preview script of the preview and version hosts — platform code served
 * by drobek, never app code.
 *
 * An HTML file the preview host (`<slug>--preview`) or a version host
 * (`<slug>--v<N>`) serves gets ONE tag before its `</body>` (before the
 * feedback widget's tag):
 *
 *   <script src="/__drobek/preview.js" defer data-app="<slug>" data-version="<N>" data-reload data-errors></script>
 *
 * (`script-src 'self'` of the app CSP covers it). `data-reload` is set on the
 * preview host only, unless the version's drobek.json says `"reload": false`;
 * `data-errors` on both, unless it says `"browserErrors": false`. A page with
 * no part switched on gets no tag. The production host and custom domains
 * never get it.
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
 * (limits, a proxy) changes nothing.
 *
 * With `data-errors` the script reports the page's uncaught errors, unhandled
 * promise rejections and `console.error` calls that pass an `Error` (never
 * `console.log`, never anything else of the page) with `sendBeacon` to
 * `/__drobek/preview/errors` on its own origin: `{ version, ua, errors:
 * [{ type, message, stack, source, line, col, path, at, count }] }` —
 * message ≤ 1 KiB, stack ≤ 4 KiB, the page's path without query or
 * fragment, the browser family only. At most one beacon a second; the same
 * error (message + stack) goes out once a minute with how often it happened
 * meanwhile (and the rest when the page is left); at most 100 reports a page.
 *
 * The script reads no cookie, sets none, and does nothing inside a frame (the
 * dashboard's app thumbnails). Its one piece of UI is `notice()`: a closed
 * shadow root at the bottom left, styled in place (no shared stylesheet).
 */
import { createHash } from 'node:crypto';

export const PREVIEW_SCRIPT_PATH = '/__drobek/preview.js';
/** The event stream of the preview host. */
export const PREVIEW_EVENTS_PATH = '/__drobek/preview/events';
/** Where the script beacons the page's errors (preview and version hosts). */
export const PREVIEW_ERRORS_PATH = '/__drobek/preview/errors';
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
  /** Report the page's errors (preview and version hosts). */
  errors: boolean;
}

export function previewScript(): PreviewScript {
  const script = Buffer.from(PREVIEW_SCRIPT_SOURCE);
  return { script, hash: createHash('sha256').update(script).digest('hex').slice(0, 16) };
}

/** The ETag marker of a page carrying the tag of `parts` (`r` = reload, `e` = errors). */
export function previewPartsKey(parts: PreviewScriptParts): string {
  return `${parts.reload ? 'r' : ''}${parts.errors ? 'e' : ''}`;
}

/** The tag injected into an HTML page served from version `versionNumber` of app `slug`; null when no part is on. */
export function previewScriptTag(slug: string, versionNumber: number, parts: PreviewScriptParts): string | null {
  if (!parts.reload && !parts.errors) return null;
  const safeSlug = slug.replace(/[^a-z0-9-]/g, '');
  const flags = `${parts.reload ? ' data-reload' : ''}${parts.errors ? ' data-errors' : ''}`;
  return `<script src="${PREVIEW_SCRIPT_PATH}" defer data-app="${safeSlug}" data-version="${Math.trunc(versionNumber)}"${flags}></script>`;
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
  var errorsOn = !!(me && me.hasAttribute('data-errors'));
  var EVENTS = ${JSON.stringify(PREVIEW_EVENTS_PATH)};
  var ERRORS = ${JSON.stringify(PREVIEW_ERRORS_PATH)};
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

  function family() {
    var u = (navigator && navigator.userAgent) || '';
    if (/Edg\\//.test(u)) return 'edge';
    if (/Firefox\\//.test(u)) return 'firefox';
    if (/Chrome\\/|CriOS\\//.test(u)) return 'chrome';
    if (/Safari\\//.test(u)) return 'safari';
    return 'other';
  }
  function hash(text) {
    var h = 0;
    for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return String(h);
  }
  function ownPath(url) {
    var u = String(url || '');
    if (u.indexOf(location.origin + '/') === 0) u = u.slice(location.origin.length);
    return u.split('?')[0].split('#')[0];
  }

  var WINDOW_MS = 60000;
  var queue = [];
  var seen = {};
  var reported = 0;
  var lastSent = 0;
  var flushTimer = 0;

  function flush() {
    flushTimer = 0;
    if (queue.length === 0 || typeof navigator.sendBeacon !== 'function') return;
    var batch = [];
    var size = 0;
    while (queue.length > 0 && batch.length < 10) {
      var next = JSON.stringify(queue[0]).length;
      if (batch.length > 0 && size + next > 14000) break;
      batch.push(queue.shift());
      size += next;
    }
    lastSent = Date.now();
    try { navigator.sendBeacon(ERRORS, JSON.stringify({ version: version, ua: family(), errors: batch })); } catch (e) { /* dropped */ }
    if (queue.length > 0) schedule();
  }
  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, Math.max(0, 1000 - (Date.now() - lastSent)));
  }
  function enqueue(report) {
    if (reported >= 100) return;
    reported++;
    queue.push(report);
    schedule();
  }
  function settle(k) {
    var s = seen[k];
    if (!s) return;
    if (s.pending > 0) {
      var again = {};
      for (var f in s.report) again[f] = s.report[f];
      again.count = s.pending;
      again.at = Date.now();
      s.pending = 0;
      enqueue(again);
    }
    delete seen[k];
  }
  function report(type, message, stack, source, line, col) {
    var text = String(message || '').slice(0, 1024);
    if (!text) return;
    var trace = stack ? String(stack).slice(0, 4096) : null;
    var k = hash(text + '\\n' + (trace || ''));
    if (seen[k]) { seen[k].pending++; return; }
    var r = {
      type: type,
      message: text,
      stack: trace,
      source: source ? ownPath(source) : null,
      line: typeof line === 'number' ? line : null,
      col: typeof col === 'number' ? col : null,
      path: location.pathname,
      at: Date.now(),
      count: 1
    };
    seen[k] = { report: r, pending: 0 };
    setTimeout(function () { settle(k); }, WINDOW_MS);
    enqueue(r);
  }
  function describe(value) {
    if (value && typeof value === 'object' && typeof value.message === 'string') {
      return (value.name ? value.name + ': ' : '') + value.message;
    }
    try { return typeof value === 'string' ? value : JSON.stringify(value); } catch (e) { return String(value); }
  }

  function collect() {
    window.addEventListener('error', function (e) {
      if (!e || typeof e.message !== 'string' || !e.message) return;
      var err = e.error;
      report('error', e.message, err && err.stack, e.filename, e.lineno, e.colno);
    });
    window.addEventListener('unhandledrejection', function (e) {
      var reason = e ? e.reason : null;
      report('unhandledrejection', describe(reason), reason && reason.stack, null, null, null);
    });
    var original = console.error;
    console.error = function () {
      try {
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          if (Object.prototype.toString.call(a) === '[object Error]') { report('console', describe(a), a.stack, null, null, null); break; }
        }
      } catch (x) { /* never breaks the page's own logging */ }
      return original.apply(console, arguments);
    };
    window.addEventListener('pagehide', function () {
      for (var k in seen) settle(k);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
      if (typeof navigator.sendBeacon !== 'function') return;
      while (queue.length > 0) flush();
    });
  }

  if (errorsOn) collect();
  if (reload) {
    restoreScroll();
    listen();
  }
})();
`;
