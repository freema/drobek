import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Landing, landingRedirectUrl, loader, meta } from './_index';

function render(): string {
  return renderToStaticMarkup(<Landing {...loader()} />);
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&rsquo;/g, '’')
    .replace(/\s+/g, ' ');
}

describe('apex landing (NSO-331)', () => {
  it('describes the cloud workspace: MCP, write → compile → preview → publish', () => {
    const body = text(render());
    expect(body).toContain('A cloud workspace for agent-built web apps');
    expect(body).toContain('connects over MCP');
    expect(body).toContain('esbuild');
    expect(body).toContain('diagnostics');
    for (const step of ['Connect.', 'Write.', 'Compile.', 'Preview.', 'Publish.']) {
      expect(body).toContain(step);
    }
    expect(body).toContain('AGPL-3.0');
    expect(body).toContain('write-only');
    expect(body).toContain('confirmation');
    expect(body).toContain('custom domains');
  });

  it('lists every built-in platform module', () => {
    const html = render();
    for (const name of ['auth', 'data', 'forms', 'email', 'files', 'proxy']) {
      expect(html).toContain(`>${name}</span>`);
    }
  });

  it('links the agent guide, /llms.txt, the GitHub repository and sign-in', () => {
    const html = render();
    expect(html).toContain('href="https://github.com/freema/drobek/blob/main/docs/AGENT.md"');
    expect(html).toContain('href="/llms.txt"');
    expect(html).toContain('href="https://github.com/freema/drobek"');
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/build-with-your-agent"');
  });

  it('has exactly one h1, then h2s only', () => {
    const html = render();
    const headings = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(headings[0]).toBe(1);
    expect(headings.filter((l) => l === 1)).toHaveLength(1);
    expect(headings.slice(1).every((l) => l === 2)).toBe(true);
  });

  it('drops the old copy and keeps the core neutral (no SaaS claims)', () => {
    const all = `${text(render())} ${JSON.stringify(meta())}`;
    for (const gone of ['micro-app', 'vibecoded', 'Drop a folder', 'MCP-native hosting']) {
      expect(all).not.toContain(gone);
    }
    for (const saas of ['hello@drobek.app', 'Brno', 'Espoo', 'pricing', 'coming soon']) {
      expect(all.toLowerCase()).not.toContain(saas.toLowerCase());
    }
    expect(all).not.toMatch(/\bI\b/);
  });

  it('meta describes the workspace', () => {
    const description = meta().find((m) => 'name' in m && m.name === 'description');
    expect(description && 'content' in description ? description.content : '').toContain(
      'open-source cloud workspace for agent-built web apps'
    );
  });
});

describe('LANDING_URL', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts only an http(s) URL', () => {
    expect(landingRedirectUrl({})).toBeNull();
    expect(landingRedirectUrl({ LANDING_URL: ' ' })).toBeNull();
    expect(landingRedirectUrl({ LANDING_URL: 'not a url' })).toBeNull();
    expect(landingRedirectUrl({ LANDING_URL: 'javascript:alert(1)' })).toBeNull();
    expect(landingRedirectUrl({ LANDING_URL: 'https://www.drobek.app' })).toBe('https://www.drobek.app/');
  });

  it('sends the apex / to the website with a 301 when set', () => {
    vi.stubEnv('LANDING_URL', 'https://www.drobek.app/');
    let thrown: unknown;
    try {
      loader();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://www.drobek.app/');
  });

  it('renders the landing when unset', () => {
    vi.stubEnv('LANDING_URL', '');
    expect(loader()).toHaveProperty('repoUrl');
  });
});
