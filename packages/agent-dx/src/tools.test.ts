import { describe, expect, it } from 'vitest';
import { TOOL_DOCS, TOOL_NAMES, toolDoc } from './tools.js';

describe('TOOL_DOCS manifest', () => {
  it('documents exactly the 25 tools, in tools/list order', () => {
    expect(TOOL_NAMES).toEqual([
      'list_apps',
      'create_app',
      'duplicate_app',
      'get_app',
      'read_file',
      'write_files',
      'restore_version',
      'publish',
      'set_gallery_listing',
      'skill_info',
      'configure_module',
      'query_data',
      'get_logs',
      'create_asset_upload',
      'list_assets',
      'delete_asset',
      'list_domains',
      'add_domain',
      'verify_domain',
      'set_primary_domain',
      'remove_domain',
      'list_upstreams',
      'register_upstream',
      'remove_upstream',
      'set_workspace_publishing',
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
      duplicate_app: [false, false, false, false], // a new copy on every call
      get_app: [true, false, true, false],
      read_file: [true, false, true, false],
      write_files: [false, true, false, false], // a new version on every call; can delete files
      restore_version: [false, true, false, false], // a new version on every call
      publish: [false, true, true, true], // changes what the public internet sees; same pointer again
      set_gallery_listing: [false, false, true, true], // a public listing; the same call again answers changed:false
      skill_info: [true, false, true, false],
      configure_module: [false, true, true, false], // the same merge patch again answers unchanged
      query_data: [true, false, true, false],
      get_logs: [true, false, true, false],
      create_asset_upload: [false, false, false, false], // a new single-use URL on every call; the PUT stores
      list_assets: [true, false, true, false],
      delete_asset: [false, true, true, false], // removes a file; a second delete changes nothing more
      list_domains: [true, false, true, false],
      add_domain: [false, false, true, false], // a second add answers domain_already_added
      verify_domain: [false, false, true, true], // asks public DNS; the same records give the same verdict
      set_primary_domain: [false, false, true, true], // where the production address sends the public
      remove_domain: [false, true, true, true], // a verified domain stops serving the public
      list_upstreams: [true, false, true, false],
      register_upstream: [false, false, true, false], // a second call answers upstream_already_registered
      remove_upstream: [false, true, true, false], // the apps calling it break; a second remove answers not_found
      set_workspace_publishing: [false, false, true, false], // who may publish; the same call again answers changed:false
    };
    expect(Object.keys(table)).toEqual(TOOL_NAMES);
    for (const [name, [readOnlyHint, destructiveHint, idempotentHint, openWorldHint]] of Object.entries(table)) {
      expect(toolDoc(name).annotations, name).toEqual({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });
    }
    // Consistency rules a directory reviewer applies: a read-only tool is never
    // destructive; only publish, the gallery listing and the domain tools that touch public DNS
    // or the public site reach the open world.
    const openWorld = ['publish', 'set_gallery_listing', 'verify_domain', 'set_primary_domain', 'remove_domain'];
    for (const t of TOOL_DOCS) {
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
      expect(t.annotations.openWorldHint, t.name).toBe(openWorld.includes(t.name));
    }
  });

  it('set_gallery_listing lists only on the user\'s explicit yes, with the publish scope (NSO-340)', () => {
    const doc = toolDoc('set_gallery_listing');
    expect(doc.scope).toMatch(/^publish\b/);
    expect(doc.description).toMatch(/user_confirmed: true/);
    expect(doc.description).toMatch(/ONLY after the user explicitly said yes/);
    expect(doc.description).toMatch(/Never list an app on your own initiative/);
    expect(doc.fields.map((f) => f.name)).toEqual(['app_id', 'listed', 'description', 'allow_duplicate', 'user_confirmed']);
  });

  it('duplicate_app copies only a duplicable gallery app, with the write scope, never secrets or data (NSO-340)', () => {
    const doc = toolDoc('duplicate_app');
    expect(doc.scope).toMatch(/^write\b/);
    expect(doc.description).toMatch(/owner allows duplicates/);
    expect(doc.description).toMatch(/Never copied: secrets, data/);
    expect(doc.fields.map((f) => f.name)).toEqual(['from', 'workspace', 'name']);
  });

  it('set_workspace_publishing is super-admin only and needs the user\'s explicit yes (NSO-366)', () => {
    const doc = toolDoc('set_workspace_publishing');
    expect(doc.scope).toMatch(/^publish \(super-admins of this server only\)/);
    expect(doc.description).toMatch(/user_confirmed: true/);
    expect(doc.description).toMatch(/ONLY after the user explicitly said yes/);
    expect(doc.fields.map((f) => f.name)).toEqual(['workspace', 'publishing', 'user_confirmed']);
    expect(doc.returns).toContain('can_publish_now');
    expect(toolDoc('publish').description).toMatch(/publish_not_approved/);
    expect(toolDoc('publish').description).toMatch(/publish_blocked/);
    expect(toolDoc('list_apps').returns).toContain('can_publish');
    expect(toolDoc('list_apps').returns).toContain('publishing');
    expect(toolDoc('get_app').returns).toContain('publishing');
  });

  it('the custom-domain tools mirror the Domains tab; what changes the public site needs the user\'s yes (NSO-366)', () => {
    expect(toolDoc('list_domains').scope).toMatch(/^read \(viewer\+/);
    for (const name of ['add_domain', 'verify_domain', 'remove_domain']) expect(toolDoc(name).scope, name).toMatch(/^write \(editor\+/);
    expect(toolDoc('set_primary_domain').scope).toMatch(/^publish \(editor\+/);
    expect(toolDoc('list_domains').returns).toContain('records');
    expect(toolDoc('add_domain').description).toContain('_drobek.<host>');
    expect(toolDoc('verify_domain').description).toMatch(/domain_not_verified/);
    expect(toolDoc('verify_domain').description).toMatch(/48 hours/);
    for (const name of ['set_primary_domain', 'remove_domain']) {
      const doc = toolDoc(name);
      expect(doc.description, name).toMatch(/user_confirmed: true/);
      expect(doc.description, name).toMatch(/ONLY after the user explicitly said yes/);
      expect(doc.fields.map((f) => f.name), name).toEqual(['app_id', 'host', 'user_confirmed']);
    }
    for (const name of ['add_domain', 'verify_domain']) {
      expect(toolDoc(name).fields.map((f) => f.name), name).toEqual(['app_id', 'host']);
      expect(toolDoc(name).description, name).not.toMatch(/user_confirmed/);
    }
    expect(toolDoc('get_app').returns).toContain('domains:[{host,status');
    expect(toolDoc('publish').returns).toContain('verified custom domains');
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
