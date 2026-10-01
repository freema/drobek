import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { WorkspaceModules, type WorkspaceModule } from './workspace-modules.js';

function mod(name: string, over: Partial<WorkspaceModule> = {}): WorkspaceModule {
  return {
    name,
    useWhen: `you need ${name}`,
    version: '1.0.0',
    source: 'builtin',
    contract: '^1.2',
    availability: 'default',
    requires: [],
    slots: [],
    contributes: [],
    editor: null,
    limits: [],
    errors: [],
    ...over,
  };
}

function render(modules: WorkspaceModule[]): string {
  const element = <WorkspaceModules modules={modules} />;
  const router = createMemoryRouter([{ path: '/', element }], { initialEntries: ['/'] });
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('WorkspaceModules', () => {
  it('marks an operator-only module and says who sees it; other modules carry no mark', () => {
    const html = render([
      mod('forms'),
      mod('sentinel', { useWhen: '', source: 'dir', operatorOnly: true, contributes: [{ slot: 'errors.reporter', host: 'core', key: 'sentinel' }] }),
    ]);
    expect(html.split('data-testid="module-operator-only"').length - 1).toBe(1);
    const card = html.slice(html.indexOf('data-module="sentinel"'));
    expect(card).toContain('data-testid="module-operator-only"');
    expect(card).toContain('Operator-only: it serves the server itself (e.g. where its errors or e-mail go). Apps cannot use it, agents do not see it, and only super-admins see it here.');
    expect(html.slice(0, html.indexOf('data-module="sentinel"'))).not.toContain('Operator-only');
  });
});
