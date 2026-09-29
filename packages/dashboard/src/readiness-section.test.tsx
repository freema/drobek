import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReadinessSection } from './readiness-section.js';
import type { ReadinessView } from './readiness.server.js';

const render = (readiness: ReadinessView | null) => renderToStaticMarkup(<ReadinessSection readiness={readiness} />);

const title = { code: 'missing_title', file: 'index.html', line: 3, message: 'index.html has no <title>.', hint: 'Add a <title>.' };

describe('ReadinessSection', () => {
  it('renders nothing for an app without versions', () => {
    expect(render(null)).toBe('');
  });

  it('a clean version: passed, with the next step', () => {
    const html = render({ state: 'ok', version: 4, report: { ready: true, blocking: [], warnings: [] } });
    expect(html).toContain('data-state="ready"');
    expect(html).toContain('v4 passed every publish check');
    expect(html).toContain('Publish it from the version list below');
  });

  it('warnings: publishable, never blocking, each with where and how to fix (escaped)', () => {
    const html = render({ state: 'ok', version: 5, report: { ready: true, blocking: [], warnings: [title], warnings_omitted: 2 } });
    expect(html).toContain('data-state="warnings"');
    expect(html).toContain('v5 can be published, with 3 things worth fixing first.');
    expect(html).toContain('never block Publish');
    expect(html).toContain('data-testid="readiness-warning" data-code="missing_title"');
    expect(html).toContain('index.html:3');
    expect(html).toContain('index.html has no &lt;title&gt;.');
    expect(html).toContain('How to fix: Add a &lt;title&gt;.');
    expect(html).toContain('and 2 more.');
  });

  it('a version that did not build: blocked, with the compile errors', () => {
    const html = render({
      state: 'ok',
      version: 6,
      report: { ready: false, blocking: [{ code: 'build_error', file: 'src/main.tsx', line: 2, message: 'Expected ";"', hint: 'Fix the file.' }], warnings: [] },
    });
    expect(html).toContain('data-state="blocked"');
    expect(html).toContain('v6 did not build, so it cannot be published.');
    expect(html).toContain('data-testid="readiness-blocking" data-code="build_error"');
  });

  it('a load failure says so and that publishing still works', () => {
    const html = render({ state: 'error', version: 7 });
    expect(html).toContain('data-state="error"');
    expect(html).toContain('could not be loaded. Publishing still works');
  });
});
