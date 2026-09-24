/**
 * The skills of a server running every built-in module — exactly what
 * `skill_info()` serves in the dev stack and the image (minus the `hello`
 * example module): the module skills of auth, email, forms, data, proxy,
 * files and the general skills of the repo's `skills/` directory (start,
 * debug, ui; `skills/drobek` is the platform skill and never listed).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noopLogger } from '@drobek/core';
import { loadModuleRuntime, memoryRateLimiter, type AnyModule, type ModuleRuntime } from '@drobek/modules';
import auth from 'drobek-module-auth';
import data from 'drobek-module-data';
import email from 'drobek-module-email';
import files from 'drobek-module-files';
import forms from 'drobek-module-forms';
import proxy from 'drobek-module-proxy';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

/** The built-in modules in the dev compose's DROBEK_MODULES order. */
export const BUILTIN_MODULES: AnyModule[] = [auth, email, forms, data, proxy, files] as AnyModule[];

/** The 9 skills an agent can read on a server with every built-in module. */
export const EXPECTED_SKILLS = ['auth', 'email', 'forms', 'data', 'proxy', 'files', 'debug', 'start', 'ui'] as const;

export interface SkillSource {
  name: string;
  kind: 'module' | 'general';
  useWhen: string;
  /** The markdown skill_info returns (frontmatter stripped). */
  content: string;
  /** The SKILL.md file on disk (repo-relative) and its full text. */
  file: string;
  fileText: string;
  module?: AnyModule;
}

let runtime: Promise<ModuleRuntime> | null = null;

/** A module runtime like the server's: the built-in modules + the repo's general skills. No DB, Redis or SMTP. */
export function skillsRuntime(): Promise<ModuleRuntime> {
  runtime ??= loadModuleRuntime({
    env: {
      APPS_DOMAIN: 'drobek.app',
      PUBLIC_APP_URL: 'https://dash.drobek.test',
      DROBEK_MIGRATE_ON_START: '0',
      DROBEK_MASTER_KEY: '33'.repeat(32),
    },
    log: noopLogger,
    modules: BUILTIN_MODULES,
    skillsDir: SKILLS_DIR,
    deps: {
      rateLimit: memoryRateLimiter(),
      principal: async () => ({ kind: 'anon' }),
      email: { send: async () => {} },
    },
  });
  return runtime;
}

export async function skillSources(): Promise<SkillSource[]> {
  const rt = await skillsRuntime();
  return rt.skills.map((s) => {
    const file = s.kind === 'module' ? `modules/${s.name}/SKILL.md` : `skills/${s.name}/SKILL.md`;
    return {
      name: s.name,
      kind: s.kind,
      useWhen: s.useWhen,
      content: s.markdown,
      file,
      fileText: readFileSync(join(REPO_ROOT, file), 'utf8'),
      ...(s.module ? { module: s.module } : {}),
    };
  });
}
