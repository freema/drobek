import { describe, expect, it } from 'vitest';
import { REACT_VERSION, TEMPLATE_IMPORTS, renderBriefing } from './briefing.js';

describe('renderBriefing', () => {
  const b = renderBriefing();

  it('covers stack, files, import map, limits, rules and next steps', () => {
    for (const h of ['## Stack', '## Files', '## Dependencies', '## Platform modules', '## Rules', '## Next']) {
      expect(b, h).toContain(h);
    }
    expect(b).toContain('/main.js');
    expect(b).toContain('/main.css');
    expect(b).toContain('drobek.json');
    expect(b).toContain('1–20');
    expect(b).toContain('300 characters');
    expect(b).toContain('200 files, 512 KiB per file, 5 MiB in total');
  });

  it('carries the pinned import map with one React version', () => {
    for (const url of Object.values(TEMPLATE_IMPORTS)) {
      expect(b).toContain(url);
      expect(url).toContain(`@${REACT_VERSION}`);
    }
    expect(TEMPLATE_IMPORTS['react-dom']).toContain(`?deps=react@${REACT_VERSION}`);
    expect(TEMPLATE_IMPORTS['react/jsx-runtime']).toBe(`https://esm.sh/react@${REACT_VERSION}/jsx-runtime`);
  });

  it('states the rules: secrets, single writer, preview_url, publish only on request', () => {
    expect(b).toContain('secret_in_source');
    expect(b).toContain('app_locked');
    expect(b).toContain('3 minutes');
    expect(b).toContain('preview_url');
    expect(b).toMatch(/only when the user explicitly asks/);
    expect(b).toContain('call `publish`');
    expect(b).toContain('Never publish on your own initiative');
  });

  it('explains the hosts, what is (not) served and the CSP', () => {
    expect(b).toContain('## Hosts');
    expect(b).toContain('<slug>--preview.<APPS_DOMAIN>');
    expect(b).toContain('<slug>--v<N>.<APPS_DOMAIN>');
    expect(b).toMatch(/NOT served: `\.ts\/\.tsx\/\.jsx` sources/);
    expect(b).toContain('https://esm.sh');
  });

  it('lists no platform module that does not exist', () => {
    expect(b).toContain('None are available on this server yet');
    expect(b).not.toContain('module_info');
    expect(b).not.toContain('drobek.data');
  });

  it('renders the live limits it is given', () => {
    const live = renderBriefing({ limits: { maxFiles: 50, maxFileBytes: 64 * 1024, maxTotalBytes: 2 * 1024 * 1024, timeoutMs: 5000 } });
    expect(live).toContain('50 files, 64 KiB per file, 2 MiB in total; a build may take 5 s');
  });
});
