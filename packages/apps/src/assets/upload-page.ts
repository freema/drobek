/**
 * The browser side of an upload URL (NSO-358): a GET of
 * `/api/assets/upload/<token>` shows what the link is for (app, asset name,
 * exact size, expiry) and a file picker that PUTs the chosen file to the
 * same URL with a progress bar — so an agent without a shell can hand the
 * link to its user. PURE (HTML string). The page carries its own CSP: one
 * nonce'd inline script and style, `connect-src 'self'` for the PUT, nothing
 * else (no framing, no forms, no other origins). Every interpolated value is
 * HTML-escaped; the token itself never appears in the page (the script PUTs
 * to its own location).
 */
import { randomBytes } from 'node:crypto';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** JSON for inside a <script>: no `<` can close the element. */
const js = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

export interface UploadPageInput {
  appSlug: string;
  name: string;
  size: number;
  expiresAt: Date;
  /** The URL the asset will have (preview host), when known. */
  assetUrl?: string | null;
}

export interface RenderedPage {
  html: string;
  csp: string;
}

function page(title: string, body: string, script = ''): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} — drobek</title>
<style nonce="${nonce}">
body{font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.2rem}code{font-family:ui-monospace,monospace;font-size:.9em}.muted{color:#6b6b70;font-size:.9rem}
.box{border:1px solid #e4e4e7;border-radius:10px;padding:1rem;margin:1rem 0;background:#fafafa}
button{padding:.45rem .9rem;font:inherit;font-weight:600;border:1px solid #1a1a1a;border-radius:8px;background:#1a1a1a;color:#fff;cursor:pointer}
button:disabled{opacity:.5;cursor:default}progress{width:100%;margin-top:.75rem}.error{color:#b91c1c}.ok{color:#166534}
</style></head><body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
  return { html, csp };
}

/** The upload page of a live link. */
export function uploadPage(input: UploadPageInput): RenderedPage {
  const body = `<h1>Upload <code>${esc(input.name)}</code> to ${esc(input.appSlug)}</h1>
<p class="muted">Pick the file (exactly ${input.size.toLocaleString('en-US')} bytes). The link works once and expires at ${esc(input.expiresAt.toISOString())}.</p>
<div class="box"><input type="file" id="file"> <button id="send" disabled>Upload</button>
<progress id="bar" max="100" value="0" hidden></progress><p id="status" class="muted" role="status"></p></div>
<p class="muted">From a terminal instead: <code>curl -T &lt;file&gt; '&lt;this link&gt;'</code></p>`;
  const script = `(function(){var f=document.getElementById('file'),b=document.getElementById('send'),p=document.getElementById('bar'),s=document.getElementById('status');var size=${js(input.size)},where=${js(input.assetUrl ?? '')};
function say(t,c){s.textContent=t;s.className=c||'muted';}
f.addEventListener('change',function(){var x=f.files&&f.files[0];if(!x){b.disabled=true;return;}if(x.size!==size){say('That file has '+x.size+' bytes; this link expects exactly '+size+'.','error');b.disabled=true;return;}say('');b.disabled=false;});
b.addEventListener('click',function(){var x=f.files&&f.files[0];if(!x)return;b.disabled=true;f.disabled=true;p.hidden=false;var r=new XMLHttpRequest();r.open('PUT',location.pathname);
r.upload.onprogress=function(e){if(e.lengthComputable)p.value=Math.round(e.loaded/e.total*100);};
r.onload=function(){var j={};try{j=JSON.parse(r.responseText);}catch(e){}if(r.status>=200&&r.status<300){p.value=100;say('Uploaded: '+(j.path||'')+(where?' ('+where+')':'')+'. You can close this page.','ok');}else{say((j.message||('Upload failed ('+r.status+').'))+' Ask for a new link.','error');}};
r.onerror=function(){say('The connection failed. Ask for a new link.','error');};r.send(x);});})();`;
  return page(`Upload ${input.name}`, body, script);
}

/** The page of a used, expired or unknown link. */
export function uploadGonePage(): RenderedPage {
  return page(
    'Upload link not valid',
    `<h1>This upload link is not valid</h1><p class="muted">Upload links work once and for 30 minutes. Ask the agent (or the app's owner in the drobek dashboard) for a new one.</p>`
  );
}
