import { beforeAll, describe, expect, it } from 'vitest';
import type { SdkBundle } from '@drobek/modules';
import { checkExamples, formatProblem, sdkFor } from './examples.js';
import { BUILTIN_MODULES, skillSources, type SkillSource } from './skills.js';

/**
 * NSO-308 acceptance: "the code in the examples does not rot". Every code block
 * of the 9 skills is compiled with @drobek/compile and typechecked against the
 * CURRENT sdk.d.ts; a renamed SDK method, a wrong prop, a config the module's
 * schema refuses or a script the CSP blocks turns `task check` red, naming the
 * SKILL.md line, the skill and the block.
 */
let sdk: SdkBundle;
beforeAll(async () => {
  sdk = await sdkFor(BUILTIN_MODULES);
});

describe('skill examples compile and typecheck against the live SDK', () => {
  it('every code block of every skill passes', async () => {
    const started = Date.now();
    const report = await checkExamples(await skillSources(), BUILTIN_MODULES, sdk);
    const ms = Date.now() - started;
    expect(report.problems.map(formatProblem), 'broken skill examples').toEqual([]);
    // Every skill contributes examples; the suite really compiled and typechecked something.
    expect(report.counts.compiled).toBeGreaterThanOrEqual(12);
    expect(report.counts.typechecked).toBeGreaterThanOrEqual(9);
    expect(report.counts.apiChecked).toBeGreaterThanOrEqual(8);
    expect(report.counts.configChecked).toBeGreaterThanOrEqual(6);
    expect(ms, 'the examples check stays fast').toBeLessThan(30_000);
  });
});

/** A one-off skill around `markdown` (the harness sees it like a real SKILL.md). */
function fakeSkill(markdown: string): SkillSource {
  return { name: 'fake', kind: 'general', useWhen: 'tests', content: markdown, file: 'skills/fake/SKILL.md', fileText: markdown };
}

async function problemsOf(markdown: string): Promise<string[]> {
  return (await checkExamples([fakeSkill(markdown)], BUILTIN_MODULES, sdk)).problems.map((p) => p.message);
}

const fence = (info: string, code: string) => '```' + info + '\n' + code + '\n```\n';

describe('the gate is real: broken examples are caught', () => {
  it('a renamed SDK method is a type error (esbuild alone would pass it)', async () => {
    const p = await problemsOf(fence('tsx', "import { drobek } from 'drobek';\nvoid drobek.auth.whoAmI();"));
    expect(p.join('\n')).toMatch(/TS2339.*whoAmI/);
    expect(p.some((m) => m.startsWith('compile'))).toBe(false);
  });

  it('a wrong inline component prop is a type error', async () => {
    const p = await problemsOf(
      fence('tsx', "import { LoginGate } from 'drobek/auth';\nexport const x = <LoginGate adminOnly>hi</LoginGate>;")
    );
    expect(p.join('\n')).toMatch(/adminOnly/);
  });

  it('an unknown drobek/<module> import and an unmapped package fail the compile', async () => {
    const p = await problemsOf(fence('tsx', "import { Chart } from 'drobek/charts';\nimport confetti from 'canvas-confetti';\nconsole.log(Chart, confetti);"));
    expect(p.filter((m) => m.startsWith('compile unresolved_import'))).toHaveLength(2);
  });

  it('a JS example is typechecked too', async () => {
    const p = await problemsOf(fence('js', "import { drobek } from 'drobek';\nawait drobek.data.collection('x').insert({});"));
    expect(p.join('\n')).toMatch(/insert/);
  });

  it('a documented API that differs from sdk.d.ts fails; the real one passes', async () => {
    const wrong = await problemsOf(
      fence('ts api', "// drobek.auth\nexport interface User { id: string; email: string; role: 'user' | 'admin' }\nexport interface Api {\n  me(): Promise<User>;\n  sendCode(email: string): Promise<{ sent: true; email: string; expires_in: number }>;\n  verify(email: string, code: string): Promise<User>;\n  logout(): Promise<void>;\n  onChange(listener: (user: User | null) => void): () => void;\n}")
    );
    expect(wrong).toEqual(['the documented `Api` differs from the real `Api` of drobek.auth in sdk.d.ts']);
    const invented = await problemsOf(fence('ts api', '// drobek.email\nexport interface Api { notifyAdmins(subject: string, text: string): Promise<{ sent: number }> }\nexport interface Template { id: string }'));
    expect(invented.join('\n')).toMatch(/Template/);
  });

  it('a configure_module payload the module schema refuses fails', async () => {
    const p = await problemsOf(fence('json', '{ "app_id": "…", "module": "auth", "config": { "allow": { "emails": ["not-an-email"] } } }'));
    expect(p.join('\n')).toMatch(/fails the "auth" schema: allow\.emails\.0/);
    const unknown = await problemsOf(fence('json', '{ "app_id": "…", "module": "payments", "config": {} }'));
    expect(unknown.join('\n')).toMatch(/unknown module "payments"/);
  });

  it('a script the apps CSP blocks, invalid JSON and an untagged block fail', async () => {
    const p = await problemsOf(
      fence('html', '<script src="https://cdn.tailwindcss.com"></script>') + fence('json', '{ nope }') + fence('', 'code')
    );
    expect(p).toHaveLength(3);
    expect(p.join('\n')).toMatch(/blocked by the apps CSP/);
    expect(p.join('\n')).toMatch(/invalid JSON/);
    expect(p.join('\n')).toMatch(/without a language/);
  });

  it('a secret in an example is refused like write_files refuses it', async () => {
    const p = await problemsOf(fence('ts', `export const key = 'sk-proj-${'a1B2c3D4e5'.repeat(4)}';`));
    expect(p.join('\n')).toMatch(/secret_in_source/);
  });
});
