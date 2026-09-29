import { describe, expect, it } from 'vitest';
import { REACT_VERSION, SERVER_INSTRUCTIONS, TEMPLATE_IMPORTS, listAppsNext, renderBriefing } from './briefing.js';

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

  it('lists in the gallery only after the user said yes (NSO-340)', () => {
    expect(b).toContain('`set_gallery_listing` ONLY after the user explicitly said yes');
    expect(b).toContain('`user_confirmed: true`');
  });

  it('points at get_logs for runtime errors and names the beacon opt-out (M1-07)', () => {
    expect(b).toContain('get_logs({ app_id, kind: "runtime" })');
    expect(b).toContain('"beacon": false');
    expect(b).toContain('create_asset_upload({ app_id, path, size })');
    expect(b).toContain('player.vimeo.com');
  });

  it('explains the hosts, what is (not) served and the CSP', () => {
    expect(b).toContain('## Hosts');
    expect(b).toContain('<slug>--preview.<APPS_DOMAIN>');
    expect(b).toContain('<slug>--v<N>.<APPS_DOMAIN>');
    expect(b).toMatch(/NOT served as files: `\.ts\/\.tsx\/\.jsx` sources/);
    expect(b).toMatch(/source map with your sources/);
    expect(b).toContain('inline on the preview and version hosts');
    expect(b).toContain('`/main.js.map`');
    expect(b).toContain('https://esm.sh');
  });

  it('with no skills: says so, keeps the skill_info rule, lists nothing that does not exist', () => {
    expect(b).toContain('This server has no platform modules and no skills');
    expect(b).toContain('call `skill_info`');
    expect(b).not.toContain('module_info');
    expect(b).not.toContain('drobek.data');
    expect(b).not.toContain('Available skills');
  });

  it('with skills: the SDK import, the rule and one line per skill', () => {
    const live = renderBriefing({
      skills: [
        { name: 'hello', use_when: 'you want to check that platform modules work' },
        { name: 'design', use_when: 'Use when the app should look polished' },
      ],
    });
    expect(live).toContain("`import { drobek } from 'drobek'` is the platform SDK");
    expect(live).toContain('call `skill_info` with the skill');
    expect(live).toContain('  - `hello` — use when you want to check that platform modules work');
    expect(live).toContain('  - `design` — use when the app should look polished');
    expect(live).toContain('never ask for their values');
  });

  it('renders the live limits it is given', () => {
    const live = renderBriefing({ limits: { maxFiles: 50, maxFileBytes: 64 * 1024, maxTotalBytes: 2 * 1024 * 1024, timeoutMs: 5000 } });
    expect(live).toContain('50 files, 64 KiB per file, 2 MiB in total; a build may take 5 s');
  });

  it('explains installing an app on a home screen with rules the server enforces (NSO-390)', () => {
    const inst = b.slice(b.indexOf('## Installable app'), b.indexOf('## Files'));
    expect(inst).toContain('`manifest.webmanifest` with write_files');
    expect(inst).toContain('application/manifest+json');
    expect(inst).toContain('`create_asset_upload`');
    expect(inst).toContain('rel="apple-touch-icon"');
    expect(inst).toContain('viewport-fit=cover');
    expect(inst).toContain('"standalone"');
    expect(inst).toContain('`published_url`');
  });

  it('says what publish\'s assets: "draft" means (NSO-390)', () => {
    expect(b).toContain('`assets: "draft"` means the uploads the preview shows are now live on production too');
  });

  it('with the data module: per-visitor state without sign-in goes to localStorage (NSO-376)', () => {
    const withData = renderBriefing({ skills: [{ name: 'data', use_when: 'the app stores records' }] });
    expect(withData).toContain('Per-visitor state without sign-in');
    expect(withData).toContain('`localStorage`');
    expect(withData).toContain('no anonymous per-visitor identity');
    expect(renderBriefing({ skills: [{ name: 'hello', use_when: 'x' }] })).not.toContain('Per-visitor state');
  });
});

describe('onboarding (NSO-379)', () => {
  it('server instructions name list_apps, the start skill, preview_url and publish-on-request', () => {
    expect(SERVER_INSTRUCTIONS).toContain('Start with `list_apps`');
    expect(SERVER_INSTRUCTIONS).toContain("skill_info('start')");
    expect(SERVER_INSTRUCTIONS).toContain('`preview_url`');
    expect(SERVER_INSTRUCTIONS).toContain('only when the user explicitly asks');
  });

  it('list_apps next names skill_info(\'start\') only when the server has it', () => {
    const withStart = listAppsNext([{ name: 'data' }, { name: 'start' }]);
    expect(withStart).toContain("call skill_info('start')");
    expect(withStart).toContain('briefing');
    const without = listAppsNext([{ name: 'data' }]);
    expect(without).not.toContain("'start'");
    expect(without).toContain('`create_app` and `get_app` return the app\'s briefing');
    expect(listAppsNext([])).toContain('if any');
  });
});
