import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SKILL_INSTALL_COMMAND } from './render.js';

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
  '## Structure your app',
  '## Define your data schema first',
  '## Use the Data API',
  '## Deploy',
  '## Check for errors',
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

  it('teaches the deploy sequence + schema-first + index.html-at-root', () => {
    expect(md).toContain('index.html');
    expect(md).toContain('collection_define');
    expect(md).toContain('deploy_init');
    expect(md).toContain('deploy_commit');
    expect(md).toContain('deploy_status');
  });

  it('links the authoritative schemas (llms.txt) rather than duplicating them', () => {
    expect(md).toContain('/llms-full.txt');
  });
});

describe('skills/drobek/README.md', () => {
  it('carries the one-command install advertised by the docs', () => {
    const readme = readFileSync(SKILL_README, 'utf8');
    expect(readme).toContain(SKILL_INSTALL_COMMAND);
  });
});
