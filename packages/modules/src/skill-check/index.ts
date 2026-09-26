/**
 * `checkSkill(module)` (NSO-349) — the SKILL.md gate the built-in modules
 * pass, for any module: a module author runs it in the module's own tests
 * (`@drobek/modules/testing`), the repo gate (packages/skills-check) runs
 * `checkSkillSources` over the built-in modules + the general skills.
 *
 *  - the format: the five sections in order, ≤ 150 lines, a one-sentence
 *    "use when", working code first, only real error codes (the core
 *    catalogue + the module's own `errors`), present tense (format.ts);
 *  - the code: every fenced block compiled with drobek's compiler and
 *    typechecked against the sdk.d.ts of the module (+ `modules`), `ts api`
 *    blocks mutually assignable to the real SDK, configure_module payloads
 *    against the module's schema (examples.ts).
 */
import type { AnyModule } from '../contract.js';
import { CORE_ERROR_CODES } from '../errors.js';
import type { SdkBundle } from '../sdk-build.js';
import { checkExamples } from './examples.js';
import { skillFormatIssues } from './format.js';
import type { SkillIssue, SkillSource } from './source.js';

export interface CheckSkillOptions {
  /**
   * Other modules the skill's examples use next to this one (e.g. the
   * built-in `auth` module for `drobek.auth`): their SDK is composed in and
   * their configure_module payloads are checked. Default: none.
   */
  modules?: AnyModule[];
  /** The SKILL.md as named in the issues (default `SKILL.md`). */
  file?: string;
  /**
   * The directory whose node_modules resolve the examples' bare imports
   * (`react` → @types/react, …); default: the working directory. An import
   * that does not resolve is typed `any`.
   */
  root?: string;
}

export interface CheckSkillSourcesOptions {
  /** The SDK bundle of `modules` (built when omitted). */
  sdk?: SdkBundle;
  /** See CheckSkillOptions.root. */
  root?: string;
}

/** The error codes a skill may name: the core catalogue + its module's `errors` (a general skill: every module's). */
export function knownErrorCodes(src: SkillSource, modules: AnyModule[]): Set<string> {
  const own = src.kind === 'module' ? (src.module?.errors ?? []) : modules.flatMap((m) => m.errors ?? []);
  return new Set([...CORE_ERROR_CODES, ...own.map((e) => e.code)]);
}

/** Format + code issues of `skills` on a server running `modules` (every module skill's module must be among them). */
export async function checkSkillSources(skills: SkillSource[], modules: AnyModule[], opts: CheckSkillSourcesOptions = {}): Promise<SkillIssue[]> {
  const format = skills.flatMap((s) => skillFormatIssues(s, knownErrorCodes(s, modules)));
  const { problems } = await checkExamples(skills, modules, opts);
  return [...format, ...problems];
}

/** The skill of one module as skill_info serves it. */
export function moduleSkillSource(module: AnyModule, file = 'SKILL.md'): SkillSource {
  return { name: module.name, kind: 'module', useWhen: module.skill.useWhen, content: module.skill.markdown, file, fileText: module.skill.markdown, module };
}

/**
 * Check a module's skill (`defineModule({ skill })`) the way drobek checks
 * its built-in modules. `[]` = it passes.
 *
 *   const issues = await checkSkill(erp);
 *   expect(issues.map(formatSkillIssue)).toEqual([]);
 */
export async function checkSkill(module: AnyModule, opts: CheckSkillOptions = {}): Promise<SkillIssue[]> {
  const others = (opts.modules ?? []).filter((m) => m.name !== module.name);
  return checkSkillSources([moduleSkillSource(module, opts.file)], [module, ...others], { root: opts.root });
}
