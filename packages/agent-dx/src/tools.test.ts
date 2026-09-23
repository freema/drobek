import { describe, expect, it } from 'vitest';
import { TOOL_DOCS, TOOL_NAMES, toolDoc } from './tools.js';

describe('TOOL_DOCS manifest', () => {
  it('documents exactly the 6 M0-05 tools, in tools/list order', () => {
    expect(TOOL_NAMES).toEqual([
      'list_apps',
      'create_app',
      'get_app',
      'read_file',
      'write_files',
      'restore_version',
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
        'openWorldHint',
        'readOnlyHint',
      ]);
    }
  });

  it('annotations follow the real effect (plan §4)', () => {
    for (const name of ['list_apps', 'get_app', 'read_file']) {
      expect(toolDoc(name).annotations.readOnlyHint, name).toBe(true);
    }
    expect(toolDoc('create_app').annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    for (const name of ['write_files', 'restore_version']) {
      expect(toolDoc(name).annotations, name).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      });
    }
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
  });

  it('toolDoc throws for an unknown tool', () => {
    expect(() => toolDoc('whoami')).toThrow();
  });
});
