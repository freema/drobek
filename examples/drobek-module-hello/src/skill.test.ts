/**
 * SKILL.md is what an agent reads (`skill_info`). checkSkill runs the gate
 * drobek runs on its built-in modules: the five sections, ≤ 150 lines, only
 * real error codes, and every code block compiled + typechecked against this
 * module's SDK types. `npm run check` runs this file alone.
 */
import { describe, expect, it } from 'vitest';
import { checkSkill, formatSkillIssue } from '@drobek/modules/testing';
import mod from './index.js';

describe('SKILL.md', () => {
  it('passes checkSkill', async () => {
    expect((await checkSkill(mod)).map(formatSkillIssue)).toEqual([]);
  });
});
