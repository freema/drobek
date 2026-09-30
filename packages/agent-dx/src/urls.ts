/**
 * Public-origin helpers for the agent docs. Mirror the resolution
 * in @drobek/oauth/resource so the rendered URLs match what
 * the running stack actually serves — without taking a dependency on those
 * packages (agent-dx is a zero-dep leaf).
 */

/** The drobek dashboard origin (dashboard + OAuth AS + MCP). */
export function publicAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.PUBLIC_APP_URL?.trim() ||
    env.PUBLIC_ORIGIN?.trim() ||
    'http://localhost:3041';
  return raw.replace(/\/+$/, '');
}

/**
 * The Streamable HTTP MCP endpoint agents connect to — also the canonical
 * OAuth resource identifier (RFC 8707 token audience). One process serves the
 * dashboard, the AS and the MCP RS, so it defaults to `PUBLIC_APP_URL + /mcp`;
 * `PUBLIC_MCP_URL` (a full endpoint URL) overrides it.
 */
export function mcpEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PUBLIC_MCP_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  return `${publicAppUrl(env)}/mcp`;
}

/**
 * RFC 9728 protected-resource metadata URL for the MCP endpoint: the
 * well-known suffix goes between the origin and the resource path.
 */
export function protectedResourceMetadataUrl(
  env: NodeJS.ProcessEnv = process.env
): string {
  const url = new URL(mcpEndpoint(env));
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * DOCS_URL — the base of a docs website with this server's docs (e.g.
 * https://www.drobek.app/docs), or null when unset. Each page lives at
 * `<DOCS_URL>/<slug>` with a Markdown twin at `<DOCS_URL>/<slug>.md`.
 * Unset: the docs link the Markdown files in the source repository. An
 * invalid value stops the server at start (`docsUrlConfigError`).
 */
export function docsUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.DOCS_URL?.trim();
  if (!raw || docsUrlConfigError(env)) return null;
  return raw.replace(/\/+$/, '');
}

/** Startup check: a human-readable error for a DOCS_URL that is not a plain http(s) URL, else null. */
export function docsUrlConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.DOCS_URL?.trim();
  if (!raw) return null;
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    return 'drobek refuses to start: DOCS_URL must be an http(s) URL without a query or fragment, e.g. https://docs.example.com/docs.';
  }
  return null;
}

/** The documentation pages the agent docs link: their slug on a DOCS_URL site and their file in the source repository. */
export const DOC_PAGES = {
  overview: 'https://github.com/freema/drobek#readme',
  agent: 'https://github.com/freema/drobek/blob/main/docs/AGENT.md',
  modules: 'https://github.com/freema/drobek/blob/main/docs/MODULES.md',
  'self-hosting': 'https://github.com/freema/drobek/blob/main/docs/SELF-HOSTING.md',
  architecture: 'https://github.com/freema/drobek/blob/main/docs/ARCHITECTURE.md',
  security: 'https://github.com/freema/drobek/blob/main/docs/SECURITY.md',
  licensing: 'https://github.com/freema/drobek/blob/main/docs/LICENSING.md',
} as const;

export type DocPage = keyof typeof DOC_PAGES;

/**
 * The URL of one docs page: `<DOCS_URL>/<slug>` (`.md` = its Markdown twin,
 * what an agent should fetch) when DOCS_URL is set, else the file in the
 * source repository (Markdown either way).
 */
export function docPageUrl(page: DocPage, env: NodeJS.ProcessEnv = process.env, opts: { markdown?: boolean } = {}): string {
  const base = docsUrl(env);
  if (!base) return DOC_PAGES[page];
  return `${base}/${page}${opts.markdown ? '.md' : ''}`;
}
