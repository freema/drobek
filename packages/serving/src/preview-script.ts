/**
 * The preview script of the preview and version hosts — platform code served
 * by drobek, never app code.
 *
 * An HTML file the preview host (`<slug>--preview`) or a version host
 * (`<slug>--v<N>`) serves gets ONE tag before its `</body>` (before the
 * feedback widget's tag):
 *
 *   <script src="/__drobek/preview.js" defer data-app="<slug>" data-version="<N>" data-reload data-errors data-screenshots></script>
 *
 * (`script-src 'self'` of the app CSP covers it). `data-reload` is set on the
 * preview host only, unless the version's drobek.json says `"reload": false`;
 * `data-errors` on both, unless it says `"browserErrors": false`;
 * `data-screenshots` on the preview host only, unless it says
 * `"screenshots": false` (and only when the script knows the dashboard
 * origin). A page with no part switched on gets no tag. The production host
 * and custom domains never get it.
 *
 * With `data-reload` or `data-screenshots` the script opens an `EventSource`
 * on its own origin (`/__drobek/preview/events`, `connect-src 'self'`). Every
 * message is one JSON object typed by its `type` field, handled by the entry
 * of `handlers` of that name (an unknown type is ignored):
 *
 *   { type: 'ready', version }                  the newest compiled version when the stream opened
 *   { type: 'version', version, compiled, errors }  a new version was stored
 *   { type: 'screenshot_requested', request_id, token, note, expires_at }
 *                                               an agent asks for a screenshot (request_screenshot)
 *   { type: 'screenshot_done', request_id }     a request was answered (in this or another tab)
 *
 * reload: a newer version that compiled reloads the page (the scroll position
 * kept in sessionStorage for the reloaded page); one that did not compile
 * shows a notice instead and the page stays as it is. A stream that cannot
 * open (limits, a proxy) changes nothing.
 *
 * screenshots: a request shows a bar — "Your agent asks for a screenshot of
 * this page", the agent's note (as text, at most 200 characters) and Capture
 * / Not now — once per request and tab (the answered ids are kept in
 * sessionStorage, so a reload does not ask again), until it expires or is
 * answered elsewhere. Capture hides the bar and calls `getDisplayMedia`
 * (`preferCurrentTab`, so Chrome offers this tab; other browsers show their
 * picker), draws the first frame, stops the stream and encodes it as a WebP
 * (JPEG where the browser cannot) of at most SCREENSHOT_MAX_BYTES; the image
 * and the request's token go with `fetch` — no credentials — to the
 * dashboard's `/api/screenshots/<request_id>` (the preview host's
 * `connect-src` allows the dashboard origin for it). Not now sends the same
 * token with `action=decline`. A browser without `getDisplayMedia` shows the
 * request with an OK button only, which declines it.
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
 * dashboard's app thumbnails). Its UI is `notice()`: a closed shadow root at
 * the bottom left (the feedback button sits at the bottom right) holding the
 * toast and the screenshot bar, styled in place in the platform theme's
 * colours (inlined at build time, light and dark; no motion under
 * `prefers-reduced-motion`).
 */
import { createHash } from 'node:crypto';
import { PLATFORM_FONT, PLATFORM_SHADOW } from '@drobek/core/platform-theme';
import { widgetThemeCss } from './widget-theme.js';

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
  /** Where the script answers screenshot requests (the dashboard origin); null → no screenshot part. */
  uploadOrigin: string | null;
}

/** Which parts of the script a page runs. */
export interface PreviewScriptParts {
  /** Reload after a write that compiled; a notice after one that did not (preview host only). */
  reload: boolean;
  /** Report the page's errors (preview and version hosts). */
  errors: boolean;
  /** Show an agent's screenshot requests (preview host only). */
  screenshots: boolean;
}

export interface PreviewScriptOptions {
  /** The dashboard origin (PUBLIC_APP_URL) screenshots are uploaded to; absent or invalid → no screenshot part. */
  dashboardOrigin?: string | null;
  /** SCREENSHOT_MAX_BYTES: the largest image the script uploads. */
  screenshotMaxBytes?: number;
}

function httpOrigin(raw: string | null | undefined): string | null {
  try {
    const url = new URL(String(raw ?? ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function previewScript(opts: PreviewScriptOptions = {}): PreviewScript {
  const uploadOrigin = httpOrigin(opts.dashboardOrigin);
  const script = Buffer.from(previewScriptSource(uploadOrigin ?? '', opts.screenshotMaxBytes ?? 1024 * 1024));
  return { script, hash: createHash('sha256').update(script).digest('hex').slice(0, 16), uploadOrigin };
}

/** The ETag marker of a page carrying the tag of `parts` (`r` = reload, `e` = errors, `s` = screenshots). */
export function previewPartsKey(parts: PreviewScriptParts): string {
  return `${parts.reload ? 'r' : ''}${parts.errors ? 'e' : ''}${parts.screenshots ? 's' : ''}`;
}

/** The tag injected into an HTML page served from version `versionNumber` of app `slug`; null when no part is on. */
export function previewScriptTag(slug: string, versionNumber: number, parts: PreviewScriptParts): string | null {
  if (!parts.reload && !parts.errors && !parts.screenshots) return null;
  const safeSlug = slug.replace(/[^a-z0-9-]/g, '');
  const flags = `${parts.reload ? ' data-reload' : ''}${parts.errors ? ' data-errors' : ''}${parts.screenshots ? ' data-screenshots' : ''}`;
  return `<script src="${PREVIEW_SCRIPT_PATH}" defer data-app="${safeSlug}" data-version="${Math.trunc(versionNumber)}"${flags}></script>`;
}

/** The shadow root's stylesheet: the platform theme's values, light and dark. */
function noticeCss(): string {
  return [
    widgetThemeCss(),
    `*{box-sizing:border-box;font:500 13px/1.4 ${PLATFORM_FONT}}`,
    `.toast,.ask{display:none;max-width:min(420px,calc(100vw - 32px));background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:12px;padding:8px 12px;box-shadow:${PLATFORM_SHADOW}}`,
    '.toast.on{display:block}',
    '.ask{padding:12px 14px;margin-top:8px}',
    '.ask.on{display:block}',
    '.ask p{margin:0}',
    '.ask .title{font-weight:600}',
    '.ask .note{margin-top:4px;color:var(--muted);overflow-wrap:anywhere}',
    '.ask .note:empty{display:none}',
    '.ask .actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}',
    'button{font-weight:600;border:1px solid var(--accent);border-radius:999px;padding:6px 14px;background:var(--accent);color:var(--accent-ink);cursor:pointer}',
    'button.secondary{background:var(--surface);color:var(--ink);border-color:var(--line)}',
    'button[hidden]{display:none}',
    'button:focus-visible{outline:2px solid var(--crumb);outline-offset:2px}',
    '@media (prefers-reduced-motion:no-preference){.toast.on,.ask.on{animation:drobek-in .18s ease-out}}',
    '@keyframes drobek-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
  ].join('');
}

/** The browser script (ES2017, no imports, no eval). */
function previewScriptSource(uploadOrigin: string, maxBytes: number): string {
  return `(function () {
  'use strict';
  var me = document.currentScript;
  try { if (window.top !== window.self) return; } catch (e) { return; }
  if (window.__drobekPreview) return;
  window.__drobekPreview = true;
  var version = Number((me && me.getAttribute('data-version')) || 0);
  var reload = !!(me && me.hasAttribute('data-reload'));
  var errorsOn = !!(me && me.hasAttribute('data-errors'));
  var UPLOAD = ${JSON.stringify(uploadOrigin)};
  var shotsOn = !!(me && me.hasAttribute('data-screenshots')) && !!UPLOAD;
  var MAX_BYTES = ${Math.max(1, Math.trunc(maxBytes))};
  var EVENTS = ${JSON.stringify(PREVIEW_EVENTS_PATH)};
  var ERRORS = ${JSON.stringify(PREVIEW_ERRORS_PATH)};
  var SCROLL_KEY = 'drobek:preview-scroll';
  var SHOTS_KEY = 'drobek:preview-screenshots';

  var ui = null;
  function notice() {
    if (ui) return ui;
    var host = document.createElement('div');
    host.setAttribute('data-drobek-preview', '');
    host.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
    root.innerHTML =
      '<style>' + ${JSON.stringify(noticeCss())} + '</style>' +
      '<div class="toast" role="status" aria-live="polite"></div>' +
      '<section class="ask" aria-live="polite" aria-label="Screenshot for your agent">' +
      '<p class="title"></p><p class="note"></p>' +
      '<div class="actions"><button type="button" data-capture>Capture</button><button type="button" class="secondary" data-decline>Not now</button></div>' +
      '</section>';
    var toast = root.querySelector('.toast');
    var ask = root.querySelector('.ask');
    var title = root.querySelector('.title');
    var note = root.querySelector('.note');
    var captureButton = root.querySelector('[data-capture]');
    var declineButton = root.querySelector('[data-decline]');
    var toastTimer = 0;
    (document.body || document.documentElement).appendChild(host);
    ui = {
      show: function (kind, text, ms) {
        host.setAttribute('data-notice', kind);
        toast.textContent = text;
        toast.className = 'toast on';
        clearTimeout(toastTimer);
        if (ms) toastTimer = setTimeout(ui.hide, ms);
      },
      hide: function () {
        host.removeAttribute('data-notice');
        toast.className = 'toast';
      },
      ask: function (text, agentNote, canCapture, onCapture, onDecline) {
        title.textContent = text;
        note.textContent = agentNote;
        captureButton.hidden = !canCapture;
        declineButton.textContent = canCapture ? 'Not now' : 'OK';
        captureButton.onclick = onCapture;
        declineButton.onclick = onDecline;
        host.setAttribute('data-ask', '');
        ask.className = 'ask on';
      },
      closeAsk: function () {
        host.removeAttribute('data-ask');
        ask.className = 'ask';
        captureButton.onclick = null;
        declineButton.onclick = null;
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
      if (reload && Number(m.version) > version) { keepScroll(); location.reload(); }
    },
    version: function (m) {
      var n = Number(m.version);
      if (!reload || !(n > version)) return;
      if (m.compiled === true) {
        keepScroll();
        location.reload();
        return;
      }
      notice().show('compile-failed', 'Version ' + n + ' did not compile \\u2014 your agent has the errors.');
    },
    screenshot_requested: function (m) {
      if (!shotsOn || typeof m.request_id !== 'string' || typeof m.token !== 'string') return;
      if (answered(m.request_id) || !(Number(m.expires_at) > Date.now())) return;
      if (pending && pending.request_id === m.request_id) return;
      askFor(m);
    },
    screenshot_done: function (m) {
      if (pending && pending.request_id === m.request_id) closeAsk();
    }
  };

  var pending = null;
  var expiryTimer = 0;
  function answeredIds() {
    try {
      var ids = JSON.parse(sessionStorage.getItem(SHOTS_KEY) || '[]');
      return Array.isArray(ids) ? ids : [];
    } catch (e) { return []; }
  }
  function answered(id) {
    return answeredIds().indexOf(id) >= 0;
  }
  function remember(id) {
    try { sessionStorage.setItem(SHOTS_KEY, JSON.stringify(answeredIds().concat([id]).slice(-20))); } catch (e) { /* storage off: a reload may ask again */ }
  }
  function closeAsk() {
    pending = null;
    clearTimeout(expiryTimer);
    if (ui) ui.closeAsk();
  }
  function canCapture() {
    return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
  }
  function askFor(m) {
    pending = m;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(function () { if (pending === m) closeAsk(); }, Math.min(Math.max(Number(m.expires_at) - Date.now(), 0), 2147483647));
    var able = canCapture();
    notice().ask(
      able ? 'Your agent asks for a screenshot of this page' : 'Your agent asks for a screenshot of this page, but this browser cannot take one \\u2014 tell your agent what you see.',
      typeof m.note === 'string' ? m.note.slice(0, 200) : '',
      able,
      function () { capture(m); },
      function () { decline(m); }
    );
  }

  function answer(m, form) {
    form.append('token', m.token);
    return fetch(UPLOAD + '/api/screenshots/' + encodeURIComponent(m.request_id), {
      method: 'POST',
      body: form,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    }).then(function (r) {
      if (r.ok) return r;
      return r.json().catch(function () { return {}; }).then(function (b) {
        throw new Error(b && typeof b.message === 'string' ? b.message : 'the answer was refused (' + r.status + ')');
      });
    });
  }
  function decline(m) {
    closeAsk();
    remember(m.request_id);
    var form = new FormData();
    form.append('action', 'decline');
    return answer(m, form).then(function () {
      notice().show('screenshot', 'OK \\u2014 your agent will not get a screenshot this time.', 5000);
    }, function (e) {
      notice().show('screenshot-failed', 'Could not tell your agent: ' + e.message, 8000);
    });
  }

  function firstFrame(stream) {
    return new Promise(function (resolve, reject) {
      var video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      var done = false;
      var draw = function () {
        if (done) return;
        done = true;
        var w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) { reject(new Error('the capture had no picture')); return; }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        resolve(canvas);
      };
      video.onloadeddata = function () { setTimeout(draw, 250); };
      video.onerror = function () { if (!done) { done = true; reject(new Error('the capture could not be read')); } };
      var played = video.play();
      if (played && typeof played.catch === 'function') played.catch(function () { /* loadeddata still fires */ });
    });
  }
  function scaled(source, side) {
    var k = Math.min(1, side / Math.max(source.width, source.height));
    if (k === 1) return source;
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(source.width * k));
    c.height = Math.max(1, Math.round(source.height * k));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c;
  }
  function encode(source) {
    var sides = [1600, 1200, 900, 640];
    var qualities = [0.85, 0.7, 0.55, 0.4];
    var i = 0, j = 0, type = 'image/webp';
    var next = function () {
      if (i >= sides.length) return Promise.reject(new Error('the screenshot is too large to send'));
      var canvas = scaled(source, sides[i]);
      return new Promise(function (resolve) { canvas.toBlob(resolve, type, qualities[j]); }).then(function (blob) {
        if (blob && blob.type !== type && type === 'image/webp') { type = 'image/jpeg'; return next(); }
        if (blob && blob.size <= MAX_BYTES) return blob;
        j++;
        if (j >= qualities.length) { j = 0; i++; }
        return next();
      });
    };
    return next();
  }
  function capture(m) {
    closeAsk();
    var stream = null;
    var stop = function () {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    };
    var shot;
    try {
      shot = navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude'
      });
    } catch (e) {
      shot = Promise.reject(e);
    }
    return shot.then(function (s) {
      stream = s;
      return firstFrame(s);
    }).then(function (canvas) {
      stop();
      return encode(canvas);
    }).then(function (blob) {
      notice().show('screenshot', 'Sending the screenshot to your agent\\u2026');
      var form = new FormData();
      form.append('screenshot', blob, blob.type === 'image/webp' ? 'screenshot.webp' : 'screenshot.jpg');
      form.append('path', location.pathname);
      form.append('browser', family());
      return answer(m, form);
    }).then(function () {
      remember(m.request_id);
      notice().show('screenshot', 'Sent \\u2014 your agent can see the screenshot now.', 5000);
    }, function (e) {
      stop();
      if (e && e.name === 'NotAllowedError') {
        if (!answered(m.request_id) && Number(m.expires_at) > Date.now()) askFor(m);
        return;
      }
      notice().show('screenshot-failed', 'The screenshot could not be sent: ' + ((e && e.message) || 'unknown error') + '.', 8000);
    });
  }

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
  if (reload) restoreScroll();
  if (reload || shotsOn) listen();
})();
`;
}
