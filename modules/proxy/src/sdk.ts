/**
 * The browser half of the proxy module: bundled into `/__drobek/sdk.js` as
 * `drobek.proxy` by the drobek server at start.
 *
 *   const res = await drobek.proxy.fetch('openai', '/v1/chat/completions', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ … }),
 *   });
 *
 * A standard `fetch` to the app's own host (`/__drobek/v1/proxy/<upstream><path>`)
 * with the end-user session cookie and the `X-Drobek-SDK: 1` header; it
 * resolves with the standard `Response` (any status — check `res.ok`). The
 * upstream's secret is injected by the server and never reaches the browser.
 */
import type { SdkCore } from '@drobek/sdk';

export interface ProxyApi {
  fetch(upstream: string, path?: string, init?: RequestInit): Promise<Response>;
}

function joinPath(path: string | undefined): string {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

export default function proxy(core: SdkCore): ProxyApi {
  const url = (upstream: string, path?: string) => core.url(`/${encodeURIComponent(upstream)}${joinPath(path)}`);
  return {
    fetch(upstream, path, init = {}) {
      const headers = new Headers(init.headers);
      headers.set('X-Drobek-SDK', '1');
      return fetch(url(upstream, path), { ...init, headers, credentials: 'same-origin' });
    },
  };
}
