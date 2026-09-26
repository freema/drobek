import { describe, expect, it } from 'vitest';
import { ERROR_CATALOGUE, TAILWIND_BROWSER_URL, TEMPLATE_IMPORTS, TOOL_NAMES, renderBriefing } from '@drobek/agent-dx';
import { CORE_ERROR_CODES } from '@drobek/modules';
import { SKILL_SECTIONS, codeBlocks, formatSkillIssue, knownErrorCodes, skillFormatIssues } from '@drobek/modules/testing';
import { BUILTIN_MODULES, EXPECTED_SKILLS, skillSources, skillsRuntime } from './skills.js';

/**
 * NSO-308: the content `skill_info` serves. Written for the AGENT only, one
 * format for all 10 skills (docs/MODULES.md "Skills"):
 *
 *   ## 1. When to use / ## 2. Minimal working code / ## 3. API and types /
 *   ## 4. Rules and limits / ## 5. Errors → fix — at most 150 lines.
 *
 * The rules are `skillFormatIssues` of @drobek/modules/testing — the same
 * `checkSkill` library an external module runs in its own tests (NSO-349).
 * The code inside is verified by examples.test.ts.
 */
const CORE_CODES = ERROR_CATALOGUE.map((e) => e.code);

const sources = await skillSources();

describe('skill_info() with every built-in module', () => {
  it('lists exactly the 10 skills — modules first, then the general skills', async () => {
    const rt = await skillsRuntime();
    expect(rt.skillList().map((s) => s.name)).toEqual([...EXPECTED_SKILLS]);
  });

  it('the checker knows exactly the catalogue codes (+ the module codes)', () => {
    expect([...CORE_ERROR_CODES].sort()).toEqual([...new Set(CORE_CODES.filter((c) => /^[a-z][a-z_]*$/.test(c)))].sort());
    const auth = sources.find((s) => s.name === 'auth')!;
    expect(knownErrorCodes(auth, BUILTIN_MODULES).has('invalid_code')).toBe(true);
    expect(knownErrorCodes(auth, BUILTIN_MODULES).has('ssrf_blocked')).toBe(false); // proxy's code, not auth's
  });

  it('the merged error catalogue (core + every built-in module) has one owner per code; skill_info returns the module codes (NSO-344)', async () => {
    const rt = await skillsRuntime();
    const moduleCodes = rt.errorCatalogue().flatMap((s) => s.errors.map((e) => e.code));
    const all = [...CORE_CODES, ...moduleCodes];
    expect(new Set(all).size).toBe(all.length);
    for (const code of ['email_not_allowed', 'invalid_code', 'too_many_attempts', 'invalid_form_token', 'submitted_too_fast', 'validation_failed', 'unsupported_type', 'ssrf_blocked', 'proxy_busy', 'path_not_allowed', 'upstream_error']) {
      expect(moduleCodes, code).toContain(code);
    }
    for (const m of BUILTIN_MODULES) {
      expect(m.contract, m.name).toBe('^1.1');
      expect(rt.skillInfo(m.name)!.errors, m.name).toEqual(m.errors ?? []);
    }
  });

  it('skill_info(name) returns the SKILL.md (without frontmatter) of every skill', async () => {
    const rt = await skillsRuntime();
    for (const src of sources) {
      const info = rt.skillInfo(src.name)!;
      expect(info, src.name).toMatchObject({ name: src.name, kind: src.kind, use_when: src.useWhen });
      expect(info.content).toBe(src.content);
      expect(src.fileText.trimEnd().endsWith(info.content.trimEnd()), src.name).toBe(true);
      if (src.kind === 'module') expect(info.sdk?.types, src.name).toContain(`export declare namespace ${src.name}`);
    }
  });
});

describe.each(sources.map((s) => [s.name, s] as const))('skill %s', (_name, src) => {
  it('passes the skill format (five sections, ≤ 150 lines, real error codes, present tense, api + configure blocks)', () => {
    expect(skillFormatIssues(src, knownErrorCodes(src, BUILTIN_MODULES)).map(formatSkillIssue)).toEqual([]);
  });
});

describe('skill start', () => {
  const start = sources.find((s) => s.name === 'start')!;

  it('names every MCP tool', () => {
    for (const tool of TOOL_NAMES) expect(start.content, tool).toContain(`\`${tool}(`);
  });

  it("shows the react-ts template's import map exactly", () => {
    const map = codeBlocks(start.content).find((b) => b.meta === 'drobek.json');
    expect(JSON.parse(map!.code)).toEqual({ imports: TEMPLATE_IMPORTS });
  });

  it('states the loop rules: preview_url, publish only on explicit request, lease, nothing runs on the server', () => {
    expect(start.content).toContain('`preview_url`');
    expect(start.content).toContain('ONLY when the user explicitly asks');
    expect(start.content).toContain('3 minutes');
    expect(start.content).toContain('never RUNS anything');
  });
});

describe('skill ui', () => {
  const ui = sources.find((s) => s.name === 'ui')!;

  it('loads the same Tailwind browser build the briefing names', () => {
    const html = codeBlocks(ui.content).find((b) => b.lang === 'html')!;
    expect(html.code).toContain(`<script type="module" src="${TAILWIND_BROWSER_URL}"></script>`);
    expect(renderBriefing()).toContain(TAILWIND_BROWSER_URL);
  });
});

describe('the format rules are real (a broken skill is caught)', () => {
  const auth = sources.find((s) => s.name === 'auth')!;
  const issuesOf = (content: string) => skillFormatIssues({ ...auth, content, fileText: content }, knownErrorCodes(auth, BUILTIN_MODULES)).map((i) => i.message);

  it('a missing section, a foreign error code, a long file and "we" are each an issue', () => {
    expect(issuesOf(auth.content.replace('## 4. Rules and limits', '## Rules')).join('\n')).toMatch(/sections must be exactly/);
    expect(issuesOf(auth.content.replace('| `invalid_code`', '| `ssrf_blocked`')).join('\n')).toMatch(/names `ssrf_blocked`/);
    expect(issuesOf(auth.content + '\ntext\n'.repeat(SKILL_SECTIONS.length * 40)).join('\n')).toMatch(/lines — a skill has at most 150/);
    expect(issuesOf(auth.content.replace('## 1. When to use\n', '## 1. When to use\n\nWe recommend it.\n')).join('\n')).toMatch(/remove "We"/);
  });
});
