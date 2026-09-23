import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generalSkillsDir, loadGeneralSkills, mergeSkills, moduleSkills, parseSkillMarkdown, skillForImport } from './skills.js';
import { echo } from './test/fixtures.js';

function skillsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'drobek-skills-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), text);
  }
  return dir;
}

describe('skills', () => {
  it('parses frontmatter', () => {
    expect(parseSkillMarkdown('---\nname: x\ndescription: "use when y"\n---\n# body\n')).toEqual({
      meta: { name: 'x', description: 'use when y' },
      body: '# body\n',
    });
    expect(parseSkillMarkdown('# no meta').meta).toEqual({});
  });

  it('loads general skills, never the platform `drobek` skill', () => {
    const dir = skillsDir({
      drobek: '---\nname: drobek\ndescription: connect\n---\n# drobek\n',
      design: '---\nname: design\ndescription: you style an app\n---\n# design\n',
      broken: '# no frontmatter\n',
      echo: '---\nname: echo\ndescription: general echo\n---\n# general echo\n',
    });
    const general = loadGeneralSkills(dir);
    expect(general.map((s) => s.name)).toEqual(['design', 'echo']);
    const merged = mergeSkills(moduleSkills([echo]), general);
    expect(merged.map((s) => [s.name, s.kind])).toEqual([
      ['echo', 'module'],
      ['design', 'general'],
    ]);
    expect(loadGeneralSkills(null)).toEqual([]);
  });

  it('finds the skills dir: DROBEK_SKILLS_DIR, ./skills, ../../skills', () => {
    const root = mkdtempSync(join(tmpdir(), 'drobek-root-'));
    mkdirSync(join(root, 'skills'));
    mkdirSync(join(root, 'apps', 'server'), { recursive: true });
    expect(generalSkillsDir({}, root)).toBe(join(root, 'skills'));
    expect(generalSkillsDir({}, join(root, 'apps', 'server'))).toBe(join(root, 'skills'));
    expect(generalSkillsDir({ DROBEK_SKILLS_DIR: '/x/y' }, root)).toBe('/x/y');
    expect(generalSkillsDir({}, mkdtempSync(join(tmpdir(), 'drobek-empty-')))).toBeNull();
  });

  it('maps backend imports to the skill that replaces them', () => {
    expect(skillForImport('firebase')).toBe('data');
    expect(skillForImport('firebase/firestore')).toBe('data');
    expect(skillForImport('firebase/auth')).toBe('auth');
    expect(skillForImport('@supabase/supabase-js')).toBe('data');
    expect(skillForImport('supabase')).toBe('data');
    expect(skillForImport('nodemailer')).toBe('email');
    expect(skillForImport('openai')).toBe('proxy');
    expect(skillForImport('react')).toBeNull();
    expect(skillForImport('pgx')).toBeNull();
  });
});
