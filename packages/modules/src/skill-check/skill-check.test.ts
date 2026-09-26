/**
 * NSO-349: `checkSkill(module)` — the SKILL.md gate of the built-in modules as
 * a library for external module authors (@drobek/modules/testing), plus the
 * test-database helpers `coreMigrationsDir()` / `createTestApp()`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { defineModule } from '../contract.js';
import { checkSkill, coreMigrationsDir, createModuleTestContext, createTestApp, formatSkillIssue } from '../testing.js';
import { echo } from '../test/fixtures.js';

const fence = (info: string, code: string) => '```' + info + '\n' + code + '\n```\n';

/** A skill for the `echo` fixture module that passes every rule. */
function goodSkill(): string {
  return [
    '# echo — echo things back',
    '',
    '## 1. When to use',
    '',
    'Use it to echo a greeting back from the server.',
    '',
    '## 2. Minimal working code',
    '',
    fence('ts', "// src/main.ts\nimport { drobek } from 'drobek';\n\nconst { greeting } = await drobek.echo.hi();\ndocument.body.textContent = greeting;"),
    '## 3. API and types',
    '',
    fence('ts api', '// drobek.echo\nexport interface Api {\n  hi(): Promise<{ greeting: string }>;\n}'),
    fence('ts api', '// drobek/echo\nexport const Echo: () => null;'),
    fence('json', '{ "app_id": "…", "module": "echo", "config": { "greeting": "Ahoj" } }'),
    '## 4. Rules and limits',
    '',
    '- `say` is limited to `ECHO_PER_MINUTE` calls per minute.',
    '',
    '## 5. Errors → fix',
    '',
    '| error | cause | fix |',
    '|---|---|---|',
    '| `rate_limited` | too many calls | wait `Retry-After` seconds |',
    '| `invalid_request` | empty text | send 1+ characters |',
    '| `csrf_rejected` | called from another origin | call through `drobek.echo` |',
    '| `echo_muted` | the owner muted it | ask the owner |',
    '',
  ].join('\n');
}

function withSkill(markdown: string, extra: Partial<Parameters<typeof defineModule>[0]> = {}) {
  return defineModule({
    ...echo,
    skill: { useWhen: 'you need to echo a greeting back from the server', markdown },
    errors: [{ code: 'echo_muted', meaning: 'HTTP 403. The owner muted echo.', fix: 'Ask the owner.' }],
    ...extra,
  } as never);
}

describe('checkSkill', () => {
  it('passes a skill in the five-section format whose code compiles and typechecks against the module SDK', async () => {
    const issues = await checkSkill(withSkill(goodSkill()));
    expect(issues.map(formatSkillIssue)).toEqual([]);
  }, 60_000);

  it('a renamed SDK method, a documented API that differs and a config the schema refuses are issues', async () => {
    const broken = goodSkill()
      .replace('drobek.echo.hi()', 'drobek.echo.hello()')
      .replace('hi(): Promise<{ greeting: string }>;', 'hi(): Promise<{ greeting: number }>;')
      .replace('"greeting": "Ahoj"', '"greeting": ""');
    const text = (await checkSkill(withSkill(broken), { file: 'modules/echo/SKILL.md' })).map(formatSkillIssue).join('\n');
    expect(text).toMatch(/modules\/echo\/SKILL\.md:\d+ \(skill "echo", code block #0\): tsc TS2339.*hello/);
    expect(text).toMatch(/the documented `Api` differs from the real `Api` of drobek\.echo/);
    expect(text).toMatch(/fails the "echo" schema: greeting/);
  }, 60_000);

  it('format: an error code neither core nor the module declares, a missing section, the size rule, a bad use-when', async () => {
    const skill = goodSkill().replace('`echo_muted`', '`echo_exploded`').replace('## 4. Rules and limits', '## Limits') + 'x\n'.repeat(150);
    const m = defineModule({ ...withSkill(skill), skill: { useWhen: 'Echo.', markdown: skill } } as never);
    const text = (await checkSkill(m)).map((i) => i.message).join('\n');
    expect(text).toMatch(/names `echo_exploded`, which is neither a core error code nor in the module's `errors`/);
    expect(text).toMatch(/sections must be exactly/);
    expect(text).toMatch(/lines — a skill has at most 150/);
    expect(text).toMatch(/"use when" must read as one sentence/);
  }, 60_000);

  it('knows the SDK of the other modules passed in `modules`', async () => {
    const other = defineModule({ ...echo, name: 'other', sdk: { entry: echo.sdk!.entry, types: 'export interface Api { hi(): Promise<{ greeting: string }>; }' } } as never);
    const skill = goodSkill().replace("document.body.textContent = greeting;", "document.body.textContent = greeting + (await drobek.other.hi()).greeting;");
    expect((await checkSkill(withSkill(skill))).map((i) => i.message).join('\n')).toMatch(/TS2339.*other/);
    expect((await checkSkill(withSkill(skill), { modules: [other] })).map(formatSkillIssue)).toEqual([]);
  }, 60_000);
});

describe('coreMigrationsDir + createTestApp', () => {
  it('points at the core migrations (the repo folder here, dist/migrations/core in the published package)', () => {
    const dir = coreMigrationsDir();
    expect(existsSync(join(dir, 'meta/_journal.json'))).toBe(true);
    const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    expect(journal.entries.length).toBeGreaterThan(10);
    expect(existsSync(join(dir, `${journal.entries[0].tag}.sql`))).toBe(true);
  });

  it('builds a PGlite database with the core schema and an app a module row can reference', async () => {
    const pg = new PGlite();
    const db = drizzle(pg);
    await migrate(db, { migrationsFolder: coreMigrationsDir(), migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
    const app = await createTestApp(db, { slug: 'erp-test' });
    expect(app).toMatchObject({ slug: 'erp-test', id: expect.any(String), workspaceId: expect.any(String) });
    const other = await createTestApp(db);
    expect(other.id).not.toBe(app.id);
    const rows = await pg.query<{ id: string }>('select id from apps where slug = $1', ['erp-test']);
    expect(rows.rows[0].id).toBe(app.id);
    const t = createModuleTestContext(echo, { app, secrets: { ECHO_TOKEN: 'x' }, config: { access: 'public' } });
    expect((await t.request('GET', '/')).body).toMatchObject({ hasToken: true });
    await pg.close();
  });
});
