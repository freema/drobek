/**
 * Skills (M1-01) — the agent-facing documentation `skill_info` serves. Two
 * sources, one registry:
 *
 *  - MODULE skills: every active module's `defineModule({ skill })`;
 *  - GENERAL skills: `skills/<name>/SKILL.md` (frontmatter `name` +
 *    `description`; the description is the "use when…" sentence) — guides
 *    that are not tied to one module.
 *
 * `skills/drobek/SKILL.md` is NOT listed: it is the platform skill an agent
 * installs to connect to drobek at all (the loop: create → write → preview →
 * publish). An agent calling `skill_info` is already connected and has the
 * same rules in the briefing; listing it would only repeat them.
 *
 * On a name clash a module skill wins over a general one (logged).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from '@drobek/core';
import type { AnyModule } from './contract.js';

/** The platform skill (installed into the agent) — never listed by skill_info. */
export const PLATFORM_SKILL_NAME = 'drobek';
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

export interface SkillEntry {
  name: string;
  kind: 'module' | 'general';
  useWhen: string;
  markdown: string;
  module?: AnyModule;
}

/** Split `---\nkey: value\n---\n` frontmatter off a SKILL.md. */
export function parseSkillMarkdown(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * Where the general skills live: `DROBEK_SKILLS_DIR`, else `<cwd>/skills` (the
 * production image copies the repo's `skills/` to `/app/skills`), else
 * `<cwd>/../../skills` (the dev server runs in `apps/server`). null = none.
 */
export function generalSkillsDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const configured = env.DROBEK_SKILLS_DIR?.trim();
  if (configured) return resolve(cwd, configured);
  for (const candidate of [resolve(cwd, 'skills'), resolve(cwd, '../../skills')]) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

/** Read every `<dir>/<name>/SKILL.md` except the platform skill. */
export function loadGeneralSkills(dir: string | null, log?: Logger): SkillEntry[] {
  if (!dir || !existsSync(dir)) return [];
  const out: SkillEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === PLATFORM_SKILL_NAME) continue;
    const file = join(dir, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const { meta, body } = parseSkillMarkdown(readFileSync(file, 'utf8'));
    const useWhen = (meta.description ?? '').trim();
    if (!SKILL_NAME_RE.test(name) || !useWhen || (meta.name && meta.name !== name)) {
      log?.warn('skipping a general skill without a valid name/description', { skill: name });
      continue;
    }
    out.push({ name, kind: 'general', useWhen, markdown: body.trim() + '\n' });
  }
  return out;
}

export function moduleSkills(modules: AnyModule[]): SkillEntry[] {
  return modules.map((m) => ({
    name: m.name,
    kind: 'module' as const,
    useWhen: m.skill.useWhen.trim(),
    markdown: m.skill.markdown.trim() + '\n',
    module: m,
  }));
}

/** Module skills first (in DROBEK_MODULES order), then general skills by name. */
export function mergeSkills(modules: SkillEntry[], general: SkillEntry[], log?: Logger): SkillEntry[] {
  const taken = new Set(modules.map((s) => s.name));
  const out = [...modules];
  for (const g of general) {
    if (taken.has(g.name)) {
      log?.warn('a general skill has the name of an active module — the module skill wins', { skill: g.name });
      continue;
    }
    out.push(g);
  }
  return out;
}

/**
 * Backend packages an agent reaches for out of habit → the skill that does the
 * job on drobek. An `unresolved_import` of one of them gets
 * `hint: "skill_info('<skill>')"` (or `skill_info()` when this server has no
 * such skill), so the agent learns the platform way instead of fighting the
 * import map.
 */
export const BACKEND_IMPORT_SKILLS: ReadonlyArray<readonly [prefix: string, skill: string]> = [
  ['firebase/auth', 'auth'],
  ['@firebase/auth', 'auth'],
  ['firebase/storage', 'files'],
  ['@firebase/storage', 'files'],
  ['firebase', 'data'],
  ['@firebase', 'data'],
  ['@supabase/supabase-js', 'data'],
  ['@supabase', 'data'],
  ['supabase', 'data'],
  ['pocketbase', 'data'],
  ['appwrite', 'data'],
  ['mongodb', 'data'],
  ['mongoose', 'data'],
  ['pg', 'data'],
  ['mysql2', 'data'],
  ['@prisma/client', 'data'],
  ['@auth0', 'auth'],
  ['auth0-js', 'auth'],
  ['@clerk', 'auth'],
  ['next-auth', 'auth'],
  ['nodemailer', 'email'],
  ['@sendgrid/mail', 'email'],
  ['resend', 'email'],
  ['@emailjs/browser', 'email'],
  ['emailjs-com', 'email'],
  ['mailgun.js', 'email'],
  ['postmark', 'email'],
  ['@formspree/react', 'forms'],
  ['uploadthing', 'files'],
  ['@uploadthing', 'files'],
  ['cloudinary', 'files'],
  ['openai', 'proxy'],
  ['@anthropic-ai/sdk', 'proxy'],
  ['stripe', 'proxy'],
];

/** The skill for a backend-ish import specifier, or null. */
export function skillForImport(specifier: string): string | null {
  for (const [prefix, skill] of BACKEND_IMPORT_SKILLS) {
    if (specifier === prefix || specifier.startsWith(`${prefix}/`)) return skill;
  }
  return null;
}
