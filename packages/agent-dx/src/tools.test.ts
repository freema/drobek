import { describe, expect, it } from 'vitest';
import { TOOL_DOCS, TOOL_NAMES } from './tools.js';

describe('TOOL_DOCS manifest', () => {
  it('documents exactly the 14 M1a/M1b tools', () => {
    expect(TOOL_NAMES.sort()).toEqual(
      [
        'app_errors',
        'app_logs',
        'collection_define',
        'deploy_commit',
        'deploy_init',
        'deploy_status',
        'list_apps',
        'record_create',
        'record_delete',
        'record_query',
        'record_read',
        'record_update',
        'rollback',
        'whoami',
      ].sort()
    );
  });

  it('has unique tool names', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it('every tool has a title, scope, description, and an example', () => {
    for (const t of TOOL_DOCS) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.scope, t.name).toBeTruthy();
      expect(t.description.length, t.name).toBeGreaterThan(10);
      expect(t.example, t.name).toBeTypeOf('object');
    }
  });

  it('every field has a name, type, and description', () => {
    for (const t of TOOL_DOCS) {
      for (const f of t.fields) {
        expect(f.name, `${t.name}.${f.name}`).toBeTruthy();
        expect(f.type, `${t.name}.${f.name}`).toBeTruthy();
        expect(f.description, `${t.name}.${f.name}`).toBeTruthy();
      }
    }
  });
});
