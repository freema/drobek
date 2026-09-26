import { afterEach, describe, expect, it } from 'vitest';
import { setModuleRuntimeForTests, type ModuleRuntime } from '@drobek/modules';
import { loader as llmsTxt } from './llms-txt';
import { loader as llmsFull } from './llms-full-txt';

describe('/llms.txt loader', () => {
  it('serves text/plain with the /llms.txt title + a tool name', async () => {
    const res = llmsTxt();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body.startsWith('# drobek')).toBe(true);
    expect(body).toContain('list_apps');
    expect(body).toContain('claude plugin marketplace add freema/drobek-plugin');
    expect(body).toContain('claude plugin install drobek@drobek');
    expect(body).toContain('https://github.com/freema/drobek/blob/main/docs/AGENT.md');
  });
});

describe('/llms-full.txt loader', () => {
  afterEach(() => setModuleRuntimeForTests(null));

  it('serves text/plain with every tool + the error catalogue', async () => {
    setModuleRuntimeForTests({ errorCatalogue: () => [] } as unknown as ModuleRuntime);
    const res = await llmsFull();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    for (const name of [
      'list_apps',
      'create_app',
      'get_app',
      'read_file',
      'write_files',
      'restore_version',
      'publish',
    ]) {
      expect(body).toContain(name);
    }
    expect(body).not.toContain('whoami');
    expect(body).toContain('## Error catalogue');
    expect(body).toContain('app_locked');
  });

  it("adds each active module's own error codes as a catalogue section (NSO-344)", async () => {
    setModuleRuntimeForTests({
      errorCatalogue: () => [{ module: 'auth', errors: [{ code: 'invalid_code', meaning: 'The code is wrong.', fix: 'Request a new one.' }] }],
    } as unknown as ModuleRuntime);
    const body = await (await llmsFull()).text();
    expect(body).toContain('### Module auth');
    expect(body).toContain('- invalid_code — module route (auth) — The code is wrong. FIX: Request a new one.');
  });
});
