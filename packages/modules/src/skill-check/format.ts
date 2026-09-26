/**
 * The skill format (NSO-308, docs/MODULES.md "Skills"): written for the AGENT
 * only, one format for every skill —
 *
 *   # <name> — <title>
 *   ## 1. When to use / ## 2. Minimal working code / ## 3. API and types /
 *   ## 4. Rules and limits / ## 5. Errors → fix — at most 150 lines.
 *
 * A module skill also documents its real SDK (`ts api` blocks) and a
 * configure_module payload; a general skill carries `name` + `description`
 * frontmatter. The code inside is checked by examples.ts.
 */
import { codeBlocks, headings, proseOf, sectionText } from './markdown.js';
import type { SkillIssue, SkillSource } from './source.js';

export const SKILL_SECTIONS = ['1. When to use', '2. Minimal working code', '3. API and types', '4. Rules and limits', '5. Errors → fix'] as const;
export const SKILL_MAX_LINES = 150;
/** Rows the "Errors → fix" table needs at least. */
const MIN_ERROR_ROWS = 4;
const FUTURE_TENSE = [/coming soon/i, /will be available/i, /in the future/i, /phase 2/i, /roadmap/i, /post-mvp/i, /\bTODO\b/];

/**
 * The format issues of one skill. `knownCodes`: the error codes the skill may
 * name in "Errors → fix" (the core catalogue + the module's own `errors`).
 */
export function skillFormatIssues(src: SkillSource, knownCodes: ReadonlySet<string>): SkillIssue[] {
  const issues: SkillIssue[] = [];
  const issue = (message: string, line = 0) => issues.push({ skill: src.name, file: src.file, block: -1, line, message });

  // skill_info() lists it as "use when <useWhen>": one sentence, lower case, no trailing period.
  const u = src.useWhen;
  if (!/^[a-z]/.test(u) || /^use when/i.test(u) || /\n|\.\s+[A-Z]|\.$/.test(u) || u.length < 30 || u.length > 220) {
    issue(`"use when" must read as one sentence after "use when …": lower-case start, 30–220 characters, no trailing period (got ${JSON.stringify(u)})`);
  }

  const lines = src.fileText.trimEnd().split('\n').length;
  if (lines > SKILL_MAX_LINES) issue(`${lines} lines — a skill has at most ${SKILL_MAX_LINES}`);

  const hs = headings(src.content);
  const h2 = hs.filter((h) => h.level === 2).map((h) => h.text);
  if (JSON.stringify(h2) !== JSON.stringify(SKILL_SECTIONS)) {
    issue(`the \`##\` sections must be exactly ${SKILL_SECTIONS.map((s) => `"${s}"`).join(', ')} in this order (found ${h2.map((s) => `"${s}"`).join(', ') || 'none'})`);
  }
  const h1 = hs.filter((h) => h.level === 1);
  if (h1.length !== 1) issue(`one \`#\` title, found ${h1.length}`);
  else if (!h1[0].text.startsWith(`${src.name} — `)) issue(`the title must start with "${src.name} — "`, h1[0].line);

  const blocks = codeBlocks(src.content);
  if (!blocks.some((b) => b.section === SKILL_SECTIONS[1] && ['tsx', 'ts', 'jsx', 'js', 'html'].includes(b.lang) && b.meta !== 'api')) {
    issue(`"${SKILL_SECTIONS[1]}" needs a code block (tsx, ts, jsx, js or html) — working code first`);
  }

  const rows = sectionText(src.content, SKILL_SECTIONS[4])
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l) && !/^\|\s*error\s*\|/.test(l));
  if (rows.length < MIN_ERROR_ROWS) issue(`"${SKILL_SECTIONS[4]}" needs a table with at least ${MIN_ERROR_ROWS} rows (| error | cause | fix |)`);
  for (const row of rows) {
    const code = /^\|\s*`([^`]+)`/.exec(row)?.[1];
    if (code && /^[a-z][a-z_]*$/.test(code) && !knownCodes.has(code)) {
      issue(`"${SKILL_SECTIONS[4]}" names \`${code}\`, which is neither a core error code nor in the module's \`errors\``);
    }
  }

  for (const re of FUTURE_TENSE) if (re.test(src.content)) issue(`written for the agent in the present tense: remove ${re}`);
  const pronoun = /\b(we|our|us)\b/i.exec(proseOf(src.content));
  if (pronoun) issue(`the prose addresses the agent, not a team: remove "${pronoun[0]}"`);

  if (src.kind === 'module') {
    const api = blocks.filter((b) => b.meta === 'api' && b.section === SKILL_SECTIONS[2]).map((b) => b.code.split('\n')[0].trim());
    if (src.module?.sdk && !api.includes(`// drobek.${src.name}`)) issue(`"${SKILL_SECTIONS[2]}" needs a \`ts api\` block starting with \`// drobek.${src.name}\` (the real SDK types)`);
    if (src.module?.sdk?.inline && !api.includes(`// drobek/${src.name}`)) {
      issue(`"${SKILL_SECTIONS[2]}" needs a \`ts api\` block starting with \`// drobek/${src.name}\` (the inline import)`);
    }
    const payloads = blocks
      .filter((b) => b.lang === 'json')
      .map((b) => {
        try {
          return JSON.parse(b.code) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((j) => j && j.module === src.name && j.config !== undefined);
    if (payloads.length === 0) issue(`needs a configure_module payload: a \`json\` block with "app_id", "module": "${src.name}" and "config"`);
  } else if (!new RegExp(`^---\\nname: ${src.name}\\ndescription: \\S`).test(src.fileText)) {
    issue(`a general skill starts with frontmatter: \`name: ${src.name}\` and the "use when" sentence as \`description\``, 1);
  }
  return issues;
}
