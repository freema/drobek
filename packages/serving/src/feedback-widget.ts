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
 * in a closed shadow root; a click lets the reviewer pick the spot their note
 * is about and opens the dashboard's `/feedback/new` page in a new window
 * (`noopener`, so neither page holds a handle on the other) with the app, the
 * version, the page path, the spot (document coordinates + viewport) and a
 * CSS selector of the element in the query. The note itself is written and
 * sent on the dashboard origin by a signed-in member of the app's workspace:
 * the app host carries no dashboard credential, and nothing the app's
 * JavaScript can read or forge on its origin sends a note.
 *
 * The widget is not drawn inside a frame (the dashboard's app thumbnails).
 */
import { createHash } from 'node:crypto';

export const FEEDBACK_SCRIPT_PATH = '/__drobek/feedback.js';

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

/** The browser script (ES2017, no imports, no eval). */
function feedbackWidgetSource(dashboardOrigin: string): string {
  return `(function () {
  'use strict';
  var DASHBOARD = ${JSON.stringify(dashboardOrigin)};
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
    }
    window.open(DASHBOARD + '/feedback/new?' + q.toString(), '_blank', 'popup=yes,width=520,height=720,noopener,noreferrer');
    say('The note form opened in a new window. Sign in there if asked.');
  }

  var host = document.createElement('div');
  host.setAttribute('data-drobek-feedback', '');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
  root.innerHTML =
    '<style>' +
    ':host,*{box-sizing:border-box;font:600 13px/1.3 system-ui,-apple-system,sans-serif}' +
    'button{border:0;border-radius:999px;padding:9px 14px;background:#1a1a1a;color:#fff;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25)}' +
    'button.secondary{background:#fff;color:#1a1a1a;border:1px solid #d4d4d8;box-shadow:none;padding:6px 10px}' +
    '.bar{display:none;position:fixed;right:16px;bottom:64px;background:#1a1a1a;color:#fff;border-radius:10px;padding:8px 12px;align-items:center;gap:10px;max-width:min(420px,calc(100vw - 32px));box-shadow:0 2px 10px rgba(0,0,0,.25)}' +
    '.bar.on{display:flex}' +
    '.toast{display:none;position:fixed;right:16px;bottom:64px;background:#fff;color:#1a1a1a;border:1px solid #d4d4d8;border-radius:10px;padding:8px 12px;max-width:280px;font-weight:500}' +
    '.toast.on{display:block}' +
    '</style>' +
    '<div class="bar" role="status"><span>Click the spot your note is about. Esc cancels.</span><button type="button" class="secondary" data-whole>Note on the whole page</button></div>' +
    '<div class="toast" role="status"></div>' +
    '<button type="button" data-start title="Leave a note for the people building this app">Feedback</button>';
  var bar = root.querySelector('.bar');
  var toast = root.querySelector('.toast');
  var timer = 0;

  function say(text) {
    toast.textContent = text;
    toast.className = 'toast on';
    clearTimeout(timer);
    timer = setTimeout(function () { toast.className = 'toast'; }, 5000);
  }

  var picking = false;
  function stop() {
    picking = false;
    bar.className = 'bar';
    document.documentElement.style.cursor = '';
    window.removeEventListener('click', onPick, true);
    window.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); stop(); } }
  function onPick(e) {
    var path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(host) >= 0) return;
    e.preventDefault();
    e.stopPropagation();
    stop();
    var target = e.target && e.target.nodeType === 1 ? e.target : null;
    open({ x: e.pageX, y: e.pageY, selector: target ? cssPath(target) : '' });
  }

  root.querySelector('[data-start]').addEventListener('click', function () {
    if (picking) { stop(); return; }
    picking = true;
    bar.className = 'bar on';
    document.documentElement.style.cursor = 'crosshair';
    setTimeout(function () {
      window.addEventListener('click', onPick, true);
      window.addEventListener('keydown', onKey, true);
    }, 0);
  });
  root.querySelector('[data-whole]').addEventListener('click', function () { stop(); open(null); });

  function mount() { (document.body || document.documentElement).appendChild(host); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
`;
}
