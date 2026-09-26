import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SKILL_INFO_RULE,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_MARKETPLACE_ADD_COMMAND,
  PLUGIN_REPO_URL,
} from './plugin.js';
import { SKILL_INSTALL_COMMAND } from './render.js';
import { TOOL_NAMES } from './tools.js';

/**
 * The drobek skill is versioned in the repo under skills/drobek/. These asserts
 * are the "ingredients" check (a real fresh-agent run is a manual operator demo):
 * the SKILL.md exists with the required sections, and the README carries the
 * one-command install that the docs advertise.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SKILL_MD = resolve(REPO_ROOT, 'skills/drobek/SKILL.md');
const SKILL_README = resolve(REPO_ROOT, 'skills/drobek/README.md');

const REQUIRED_SECTIONS = [
  '## Your workspace',
  '## Create an app',
  '## Write files, read the compile result',
  '## Port a Claude artifact',
  '## One writer at a time',
  '## Roll back',
  '## Publishing',
  '## Gallery',
  '## Errors',
  '## Authoritative schemas',
];

describe('skills/drobek/SKILL.md', () => {
  const md = readFileSync(SKILL_MD, 'utf8');

  it('has YAML frontmatter with a name + description', () => {
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toMatch(/\nname:\s*drobek/);
    expect(md).toMatch(/\ndescription:\s*\S/);
  });

  it('has every required section', () => {
    for (const s of REQUIRED_SECTIONS) expect(md, s).toContain(s);
  });

  it('teaches the create → write → preview loop with every current tool, never a removed one', () => {
    for (const tool of TOOL_NAMES) expect(md, tool).toContain(tool);
    // doc-lint: allow — retired tool names, asserted absent
    for (const gone of ['whoami', 'collection_define', 'record_create', 'app_errors', 'app_logs', 'deploy_init']) {
      expect(md, gone).not.toContain(gone);
    }
    expect(md).toContain('preview_url');
    expect(md).toContain('untrusted');
  });

  it('links the authoritative schemas (llms.txt) rather than duplicating them', () => {
    expect(md).toContain('/llms-full.txt');
    expect(md).toContain('https://drobek.app/llms-full.txt');
  });

  it('states the loop rules: preview_url, publish only on request, single writer, no secrets (M0-10)', () => {
    expect(md).toContain('`compile.ok: true` → give the user the `preview_url`');
    expect(md).toContain('Publish **only when the user explicitly asks**');
    expect(md).toContain('Never publish on your own initiative');
    expect(md).toContain('`app_locked`');
    expect(md).toContain('3 minutes');
    expect(md).toContain('`secret_in_source`');
    expect(md).toContain('drobek dashboard');
  });

  it('lists an app in the gallery only after the user said yes (NSO-340)', () => {
    expect(md).toContain('**only after the user explicitly said yes**');
    expect(md).toContain('user_confirmed: true');
    expect(md).toContain('Never list on your own');
  });

  it('ports a Claude artifact: text via write_files, binaries via create_asset_upload at the same path, never base64 (NSO-359)', () => {
    const port = md.slice(md.indexOf('## Port a Claude artifact'), md.indexOf('## One writer at a time'));
    expect(port).toContain("skill_info('port-artifact')");
    expect(port).toContain('the server\nfetches nothing from claude.ai');
    for (const tool of ['create_app', 'write_files', 'create_asset_upload', 'list_assets', 'publish', 'set_gallery_listing']) {
      expect(port, tool).toContain(`\`${tool}\``);
    }
    expect(port).toContain('SAME relative path');
    expect(port).toContain('never base64 through a tool call');
    expect(port).toContain('`window.claude.*`');
  });

  it('states the skill_info rule verbatim, in the present tense (M1-01)', () => {
    expect(md).toContain(SKILL_INFO_RULE);
    expect(md).not.toContain('module_info');
    for (const future of ['later', 'phase 2', 'coming soon', 'will be available']) {
      expect(md.toLowerCase(), future).not.toContain(future);
    }
  });
});

describe('skills/drobek/README.md', () => {
  const readme = readFileSync(SKILL_README, 'utf8');

  it('carries the one-command install advertised by the docs', () => {
    expect(readme).toContain(SKILL_INSTALL_COMMAND);
  });

  it('points at the drobek plugin with the exact Claude Code install commands', () => {
    expect(readme).toContain(PLUGIN_MARKETPLACE_ADD_COMMAND);
    expect(readme).toContain(PLUGIN_INSTALL_COMMAND);
    expect(readme).toContain(PLUGIN_REPO_URL);
  });
});
