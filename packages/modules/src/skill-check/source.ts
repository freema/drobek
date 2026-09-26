import type { AnyModule } from '../contract.js';

/** One skill as the checker sees it (a module's `skill.markdown`, or a general `skills/<name>/SKILL.md`). */
export interface SkillSource {
  name: string;
  kind: 'module' | 'general';
  useWhen: string;
  /** The markdown skill_info returns (a general skill: without its frontmatter). */
  content: string;
  /** The SKILL.md as named in the issues (e.g. `SKILL.md`, `modules/auth/SKILL.md`). */
  file: string;
  /** The file's full text (frontmatter included). */
  fileText: string;
  module?: AnyModule;
}

/** One finding of `checkSkill` / `checkSkillSources`. */
export interface SkillIssue {
  skill: string;
  /** The SKILL.md (see SkillSource.file). */
  file: string;
  /** 0-based index of the code block in the file; -1 when the issue is not about one block. */
  block: number;
  /** 1-based line in the SKILL.md (0 when the issue concerns the whole file). */
  line: number;
  message: string;
}

/** `SKILL.md:12 (skill "erp", code block #2): message` */
export function formatSkillIssue(p: SkillIssue): string {
  return `${p.file}:${p.line} (skill "${p.skill}"${p.block >= 0 ? `, code block #${p.block}` : ''}): ${p.message}`;
}
