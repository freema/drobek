import { describe, expect, it } from 'vitest';
import { ERROR_CATALOGUE, TAILWIND_BROWSER_URL, TEMPLATE_IMPORTS, TOOL_NAMES, renderBriefing } from '@drobek/agent-dx';
import { codeBlocks, headings, proseOf, sectionText } from './markdown.js';
import { EXPECTED_SKILLS, skillSources, skillsRuntime } from './skills.js';

/**
 * NSO-308: the content `skill_info` serves. Written for the AGENT only, one
 * format for all 9 skills (docs/MODULES.md "Skills"):
 *
 *   ## 1. When to use / ## 2. Minimal working code / ## 3. API and types /
 *   ## 4. Rules and limits / ## 5. Errors → fix — at most 150 lines.
 *
 * The code inside is verified by examples.test.ts.
 */
export const SECTIONS = ['1. When to use', '2. Minimal working code', '3. API and types', '4. Rules and limits', '5. Errors → fix'];
const MAX_LINES = 150;
const KNOWN_CODES = new Set(ERROR_CATALOGUE.map((e) => e.code));

const sources = await skillSources();

describe('skill_info() with every built-in module', () => {
  it('lists exactly the 9 skills — modules first, then the general skills — each with a one-sentence "use when"', async () => {
    const rt = await skillsRuntime();
    const list = rt.skillList();
    expect(list.map((s) => s.name)).toEqual([...EXPECTED_SKILLS]);
    for (const s of list) {
      expect(s.use_when, s.name).toMatch(/^[a-z]/); // reads as "use when <use_when>"
      expect(s.use_when, s.name).not.toMatch(/^use when/i);
      expect(s.use_when, s.name).not.toMatch(/\n|\.\s+[A-Z]|\.$/); // one sentence, no trailing period
      expect(s.use_when.length, s.name).toBeGreaterThanOrEqual(30);
      expect(s.use_when.length, s.name).toBeLessThanOrEqual(220);
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

describe.each(sources.map((s) => [s.name, s] as const))('skill %s', (name, src) => {
  it(`is at most ${MAX_LINES} lines`, () => {
    expect(src.fileText.trimEnd().split('\n').length).toBeLessThanOrEqual(MAX_LINES);
  });

  it('has exactly the five sections, in order', () => {
    const h2 = headings(src.content).filter((h) => h.level === 2).map((h) => h.text);
    expect(h2).toEqual(SECTIONS);
    const h1 = headings(src.content).filter((h) => h.level === 1);
    expect(h1).toHaveLength(1);
    expect(h1[0].text.startsWith(`${name} — `)).toBe(true);
  });

  it('shows working code first: section 2 has a compiled code block', () => {
    const blocks = codeBlocks(src.content).filter((b) => b.section === SECTIONS[1]);
    expect(blocks.some((b) => ['tsx', 'ts', 'jsx', 'js', 'html'].includes(b.lang) && b.meta !== 'api')).toBe(true);
  });

  it('lists only real error codes in "Errors → fix"', () => {
    const rows = sectionText(src.content, SECTIONS[4])
      .split('\n')
      .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l) && !/^\|\s*error\s*\|/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      const code = /^\|\s*`([^`]+)`/.exec(row)?.[1];
      if (code && /^[a-z][a-z_]*$/.test(code)) expect(KNOWN_CODES.has(code), `${name}: unknown error code \`${code}\``).toBe(true);
    }
  });

  it('is written for the agent, in the present tense', () => {
    for (const re of [/coming soon/i, /will be available/i, /in the future/i, /phase 2/i, /roadmap/i, /post-mvp/i, /\bTODO\b/]) {
      expect(src.content, String(re)).not.toMatch(re);
    }
    expect(proseOf(src.content)).not.toMatch(/\b(we|our|us)\b/i);
  });

  if (src.kind === 'module') {
    it('documents the real SDK types (a `ts api` block per import) and a configure_module payload', () => {
      const api = codeBlocks(src.content).filter((b) => b.meta === 'api' && b.section === SECTIONS[2]);
      expect(api.map((b) => b.code.split('\n')[0].trim())).toContain(`// drobek.${name}`);
      if (src.module?.sdk?.inline) expect(api.map((b) => b.code.split('\n')[0].trim())).toContain(`// drobek/${name}`);
      const payloads = codeBlocks(src.content)
        .filter((b) => b.lang === 'json')
        .map((b) => JSON.parse(b.code) as Record<string, unknown>)
        .filter((j) => j.module === name && j.config !== undefined);
      expect(payloads.length).toBeGreaterThanOrEqual(1);
    });
  } else {
    it('has frontmatter naming it, with the "use when" sentence as description', () => {
      expect(src.fileText).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: \\S`));
    });
  }
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
