import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { UpstreamsEditor, type EditorError, type UpstreamRow } from './rules-editors.js';

function row(name: string, over: Partial<UpstreamRow> = {}): UpstreamRow {
  return { name, registered: true, assigned: false, call: 'user', rateLimit: null, hasSecret: false, methods: ['GET'], prefixes: ['/rss'], ...over };
}

function render(upstreams: UpstreamRow[], opts: { canEdit?: boolean; error?: EditorError | null } = {}): string {
  const element = <UpstreamsEditor upstreams={upstreams} workspaceSlug="acme" canEdit={opts.canEdit ?? true} error={opts.error ?? null} />;
  const router = createMemoryRouter([{ path: '/', element }], { initialEntries: ['/'] });
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

const feeds = (n: number) => Array.from({ length: n }, (_, i) => row(`feed-${i + 1}`));

describe('UpstreamsEditor', () => {
  it('no upstreams in the workspace: says so and points to the Upstreams page', () => {
    const html = render([]);
    expect(html).toContain('data-testid="upstreams-none"');
    expect(html).toContain('This workspace has no upstreams yet.');
    expect(html).toContain('href="/workspaces/acme/upstreams"');
    expect(html).not.toContain('data-testid="upstreams-unassigned"');
    expect(html).not.toContain('data-testid="upstreams-all-assigned"');
  });

  it('assigned (and assigned-but-unregistered) upstreams are full cards on top; the rest a compact list below', () => {
    const html = render([
      row('alpha'),
      row('echo', { assigned: true, call: 'public', rateLimit: 30, hasSecret: true }),
      row('gone', { registered: false, assigned: true }),
      row('beta', { hasSecret: true, methods: ['GET', 'POST'], prefixes: ['/a', '/b'] }),
    ]);
    const echo = html.indexOf('<section style="');
    const list = html.indexOf('data-testid="upstreams-unassigned"');
    expect(echo).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(html.indexOf('data-testid="upstream-gone"'));
    expect(html.indexOf('data-testid="upstream-echo"')).toBeLessThan(list);
    expect(html.indexOf('data-testid="upstream-alpha"')).toBeGreaterThan(list);
    expect(html).toContain('data-testid="upstream-unassign-echo"');
    expect(html).toContain('data-testid="upstream-unregistered-gone"');
    expect(html).toContain('data-testid="upstream-ratelimit-echo"');
    expect(html).toContain('Other upstreams in this workspace (2)');
    expect(html).toContain('GET, POST · /a, /b');
    expect(count(html, 'secret set')).toBe(2);
    expect(html).toContain('data-testid="upstream-assign-alpha"');
    expect(html).toContain('data-testid="upstream-save-alpha"');
    expect(html).not.toContain('data-testid="upstream-unassign-alpha"');
    expect(html).not.toContain('data-testid="upstream-filter"');
  });

  it("an unassigned upstream's rule form sits in a closed <details> with today's save-upstream fields", () => {
    const html = render([row('alpha')]);
    expect(html).toMatch(/<details[^>]*data-testid="upstream-assign-alpha"/);
    expect(html).not.toMatch(/<details open=""[^>]*data-testid="upstream-assign-alpha"/);
    expect(html).toContain('name="intent" value="save-upstream"');
    expect(html).toContain('name="upstream" value="alpha"');
    expect(html).toContain('name="rateLimit"');
    expect(html).toContain('data-testid="call-alpha-call-user"');
    expect(html).toContain('No upstream is assigned to this app yet.');
  });

  it('an error for an unassigned upstream opens its form', () => {
    const html = render([row('alpha')], { error: { intent: 'save-upstream', target: 'alpha', fields: { rateLimit: ['must be a number'] }, general: [] } });
    expect(html).toMatch(/<details open=""[^>]*data-testid="upstream-assign-alpha"/);
    expect(html).toContain('data-testid="upstream-error-alpha"');
    expect(html).toContain('rateLimit: must be a number');
  });

  it('every upstream assigned: no compact list, a note instead', () => {
    const html = render([row('echo', { assigned: true })]);
    expect(html).toContain('data-testid="upstreams-all-assigned"');
    expect(html).not.toContain('data-testid="upstreams-unassigned"');
    expect(html).not.toContain('data-testid="upstreams-none-assigned"');
  });

  it('more than 8 unassigned upstreams get a name filter; 8 do not', () => {
    expect(render(feeds(8))).not.toContain('data-testid="upstream-filter"');
    const html = render([row('echo', { assigned: true }), ...feeds(50)]);
    expect(html).toContain('data-testid="upstream-filter"');
    expect(html).toContain('Other upstreams in this workspace (50)');
    expect(count(html, '<details')).toBe(50);
    expect(html).not.toContain('data-testid="upstream-filter-empty"');
    expect(count(html, '<section')).toBe(1);
  });

  it('a viewer sees assigned bodies disabled and the compact list without actions', () => {
    const html = render([row('echo', { assigned: true }), ...feeds(9)], { canEdit: false });
    expect(html).toContain('data-testid="upstream-echo"');
    expect(html).toContain('data-testid="call-echo-call-user"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('data-testid="upstream-save-');
    expect(html).toContain('data-testid="upstream-feed-9"');
    expect(html).toContain('This app cannot call these upstreams.');
  });
});
