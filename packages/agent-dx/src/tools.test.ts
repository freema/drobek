import { describe, expect, it } from 'vitest';
import { TOOL_DOCS, TOOL_NAMES, toolDoc } from './tools.js';

describe('TOOL_DOCS manifest', () => {
  it('documents exactly the 11 tools, in tools/list order', () => {
    expect(TOOL_NAMES).toEqual([
      'list_apps',
      'create_app',
      'get_app',
      'read_file',
      'write_files',
      'restore_version',
      'publish',
      'skill_info',
      'configure_module',
      'query_data',
      'get_logs',
    ]);
  });

  it('has unique tool names', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it('every tool has a title, scope, description, annotations, returns and an example', () => {
    for (const t of TOOL_DOCS) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.scope, t.name).toMatch(/^(read|write|publish)\b/);
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.returns, t.name).toBeTruthy();
      expect(t.example, t.name).toBeTypeOf('object');
      expect(Object.keys(t.annotations).sort(), t.name).toEqual([
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
        'readOnlyHint',
      ]);
    }
  });

  it('annotations follow the real effect (plan §4; the full table, NSO-307)', () => {
    // [readOnly, destructive, idempotent, openWorld] — every hint explicit, checked
    // against the live server in docs/listing/inspector-log.md.
    const table: Record<string, [boolean, boolean, boolean, boolean]> = {
      list_apps: [true, false, true, false],
      create_app: [false, false, false, false], // a new app on every call
      get_app: [true, false, true, false],
      read_file: [true, false, true, false],
      write_files: [false, true, false, false], // a new version on every call; can delete files
      restore_version: [false, true, false, false], // a new version on every call
      publish: [false, true, true, true], // changes what the public internet sees; same pointer again
      skill_info: [true, false, true, false],
      configure_module: [false, true, true, false], // the same merge patch again answers unchanged
      query_data: [true, false, true, false],
      get_logs: [true, false, true, false],
    };
    expect(Object.keys(table)).toEqual(TOOL_NAMES);
    for (const [name, [readOnlyHint, destructiveHint, idempotentHint, openWorldHint]] of Object.entries(table)) {
      expect(toolDoc(name).annotations, name).toEqual({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });
    }
    // Consistency rules a directory reviewer applies: a read-only tool is never
    // destructive; only publish reaches the open world.
    for (const t of TOOL_DOCS) {
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
      expect(t.annotations.openWorldHint, t.name).toBe(t.name === 'publish');
    }
  });

  it('publish is documented as explicit-request only, with the publish scope', () => {
    expect(toolDoc('publish').scope).toMatch(/^publish\b/);
    expect(toolDoc('publish').description).toMatch(/ONLY when the user explicitly asks/);
  });

  it('every field has a name, type, and description; examples only use documented fields', () => {
    for (const t of TOOL_DOCS) {
      const names = t.fields.map((f) => f.name);
      for (const f of t.fields) {
        expect(f.name, `${t.name}.${f.name}`).toBeTruthy();
        expect(f.type, `${t.name}.${f.name}`).toBeTruthy();
        expect(f.description, `${t.name}.${f.name}`).toBeTruthy();
      }
      for (const key of Object.keys(t.example)) expect(names, `${t.name} example`).toContain(key);
      for (const f of t.fields.filter((x) => x.required)) {
        expect(Object.keys(t.example), `${t.name} example has ${f.name}`).toContain(f.name);
      }
    }
  });

  it('read_file tells the agent its content is untrusted', () => {
    expect(toolDoc('read_file').description).toMatch(/UNTRUSTED/);
    expect(toolDoc('read_file').returns).toContain('untrusted:true');
    // NSO-324: the untrusted tools answer text only — no structuredContent past the envelope.
    for (const name of ['read_file', 'query_data', 'get_logs']) {
      expect(toolDoc(name).description, name).toMatch(/no structuredContent/);
      expect(toolDoc(name).returns, name).toMatch(/^text only/);
    }
  });

  it('skill_info never returns secrets; configure_module routes secrets to the dashboard (M1-01)', () => {
    expect(toolDoc('skill_info').scope).toMatch(/^read\b/);
    expect(toolDoc('skill_info').description).toMatch(/Never returns secret values or any app's config/);
    expect(toolDoc('configure_module').scope).toMatch(/^write\b/);
    expect(toolDoc('configure_module').description).toMatch(/confirm_url/);
    expect(toolDoc('configure_module').description).toMatch(/Secrets are never set here/);
  });

  it('query_data reads (≤ 100 records) and marks the records untrusted (M1-03)', () => {
    expect(toolDoc('query_data').scope).toMatch(/^read\b/);
    expect(toolDoc('query_data').description).toMatch(/untrusted/);
    expect(toolDoc('query_data').description).toMatch(/at most 100 records/);
    expect(toolDoc('query_data').returns).toContain('untrusted:true');
  });

  it('get_logs reads runtime / compile / requests and marks the entries untrusted (M1-07)', () => {
    const doc = toolDoc('get_logs');
    expect(doc.scope).toMatch(/^read\b/);
    expect(doc.annotations.readOnlyHint).toBe(true);
    for (const kind of ['runtime', 'compile', 'requests']) expect(doc.description).toContain(`"${kind}"`);
    expect(doc.description).toMatch(/last 50 compiles/);
    expect(doc.description).toMatch(/untrusted/);
    expect(doc.returns).toContain('untrusted:true');
    expect(doc.fields.map((f) => f.name)).toEqual(['app_id', 'kind', 'since']);
  });

  it('toolDoc throws for an unknown tool', () => {
    expect(() => toolDoc('whoami')).toThrow();
  });
});
