import { describe, expect, it } from 'vitest';
import { TOOL_DOCS, TOOL_NAMES, toolDoc } from './tools.js';

describe('TOOL_DOCS manifest', () => {
  it('documents exactly the 59 tools, in tools/list order', () => {
    expect(TOOL_NAMES).toEqual([
      'list_apps',
      'create_app',
      'duplicate_app',
      'get_app',
      'read_file',
      'write_files',
      'restore_version',
      'list_versions',
      'keep_version',
      'delete_versions',
      'publish',
      'set_gallery_listing',
      'unpublish',
      'set_visibility',
      'set_frame_ancestors',
      'release_lease',
      'delete_app',
      'skill_info',
      'configure_module',
      'query_data',
      'create_records',
      'update_record',
      'delete_record',
      'delete_collection',
      'purge_orphan_records',
      'get_logs',
      'sync_now',
      'create_asset_upload',
      'list_assets',
      'delete_asset',
      'list_form_submissions',
      'delete_form_submission',
      'list_end_users',
      'set_end_user_role',
      'set_end_user_blocked',
      'sign_out_end_users',
      'list_uploads',
      'delete_upload',
      'remove_module_secret',
      'list_activity',
      'list_domains',
      'add_domain',
      'verify_domain',
      'set_primary_domain',
      'remove_domain',
      'list_upstreams',
      'register_upstream',
      'remove_upstream',
      'create_workspace',
      'list_members',
      'invite_member',
      'set_member_role',
      'remove_member',
      'delete_workspace',
      'set_workspace_publishing',
      'set_workspace_module',
      'takedown_app',
      'restore_app',
      'set_gallery_hidden',
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

  it('annotations follow the real effect (the full table)', () => {
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
      list_versions: [true, false, true, false],
      keep_version: [false, false, true, false], // the same state again answers changed:false
      delete_versions: [false, true, true, false], // versions gone for good; a second call finds nothing more to delete
      publish: [false, true, true, true], // changes what the public internet sees; same pointer again
      set_gallery_listing: [false, false, true, true], // a public listing; the same call again answers changed:false
      unpublish: [false, true, true, true], // the production address goes 404; a second call answers not_published
      set_visibility: [false, true, true, true], // who can open the public site; public drops the stored password
      set_frame_ancestors: [false, false, true, true], // which sites may frame the public site; the same list again answers changed:false
      release_lease: [false, false, true, false], // frees only the caller's own lease; a second call answers released:false
      delete_app: [false, true, true, true], // every host goes 404; a second call answers not_found
      skill_info: [true, false, true, false],
      configure_module: [false, true, true, false], // the same merge patch again answers unchanged
      query_data: [true, false, true, false],
      create_records: [false, false, false, false], // new records on every call
      update_record: [false, true, true, false], // overwrites fields; the same fields again change nothing
      delete_record: [false, true, true, false], // a second delete answers not_found
      delete_collection: [false, true, true, false], // records + declaration gone; a second call answers not_found
      purge_orphan_records: [false, true, true, false], // a second call finds nothing to purge
      get_logs: [true, false, true, false],
      sync_now: [false, true, false, true], // replace mode swaps the collection's records; calls the app's external API
      create_asset_upload: [false, false, false, false], // a new single-use URL on every call; the PUT stores
      list_assets: [true, false, true, false],
      delete_asset: [false, true, true, false], // removes a file; a second delete changes nothing more
      list_form_submissions: [true, false, true, false],
      delete_form_submission: [false, true, true, false], // a second delete answers not_found
      list_end_users: [true, false, true, false],
      set_end_user_role: [false, true, true, false], // can take admin rights away; the same role again changes nothing
      set_end_user_blocked: [false, true, true, false], // ends the user's sessions; the same state again changes nothing
      sign_out_end_users: [false, true, false, false], // every call signs out whoever signed in since
      list_uploads: [true, false, true, false],
      delete_upload: [false, true, true, false], // a second delete answers not_found
      remove_module_secret: [false, true, true, false], // a second call answers removed:false
      list_activity: [true, false, true, false],
      list_domains: [true, false, true, false],
      add_domain: [false, false, true, false], // a second add answers domain_already_added
      verify_domain: [false, false, true, true], // asks public DNS; the same records give the same verdict
      set_primary_domain: [false, false, true, true], // where the production address sends the public
      remove_domain: [false, true, true, true], // a verified domain stops serving the public
      list_upstreams: [true, false, true, false],
      register_upstream: [false, false, true, false], // a second call answers upstream_already_registered
      remove_upstream: [false, true, true, false], // the apps calling it break; a second remove answers not_found
      create_workspace: [false, false, true, false], // a second call with the same slug answers slug_taken
      list_members: [true, false, true, false],
      invite_member: [false, false, false, true], // every call e-mails a new link to someone outside the conversation
      set_member_role: [false, false, true, false], // the same role again answers changed:false
      remove_member: [false, true, true, false], // the member loses access; a second remove answers not_found
      delete_workspace: [false, true, true, false], // everything in it goes; a second call answers not_found
      set_workspace_publishing: [false, false, true, false], // who may publish; the same call again answers changed:false
      set_workspace_module: [false, true, true, false], // disabling turns it off for every app of the workspace; the same state again answers changed:false
      takedown_app: [false, true, true, true], // unpublishes; every host answers 451; a second call answers changed:false
      restore_app: [false, false, true, true], // the preview and version hosts serve again; a second call answers changed:false
      set_gallery_hidden: [false, false, true, true], // what the public gallery shows; the same state again answers changed:false
    };
    expect(Object.keys(table)).toEqual(TOOL_NAMES);
    for (const [name, [readOnlyHint, destructiveHint, idempotentHint, openWorldHint]] of Object.entries(table)) {
      expect(toolDoc(name).annotations, name).toEqual({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });
    }
    // Consistency rules a directory reviewer applies: a read-only tool is never
    // destructive; only publish, the gallery listing, the lifecycle tools and the domain tools that
    // touch public DNS or the public site, sync_now (it calls the app's external API), invite_member (it e-mails
    // someone outside the conversation) and the super-admin's moderation tools reach the open world.
    const openWorld = [
      'publish',
      'set_gallery_listing',
      'unpublish',
      'set_visibility',
      'set_frame_ancestors',
      'delete_app',
      'sync_now',
      'verify_domain',
      'set_primary_domain',
      'remove_domain',
      'invite_member',
      'takedown_app',
      'restore_app',
      'set_gallery_hidden',
    ];
    for (const t of TOOL_DOCS) {
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
      expect(t.annotations.openWorldHint, t.name).toBe(openWorld.includes(t.name));
    }
  });

  it('the version history tools: list_versions reads, keep_version and delete_versions are editor+ writes, the clean-up only on the user\'s yes', () => {
    expect(toolDoc('list_versions').scope).toMatch(/^read \(any role/);
    expect(toolDoc('list_versions').fields.map((f) => f.name)).toEqual(['app_id', 'before', 'limit']);
    expect(toolDoc('list_versions').returns).toContain('next_before');
    expect(toolDoc('list_versions').description).toContain('APP_VERSIONS_PAGE');
    for (const name of ['keep_version', 'delete_versions']) expect(toolDoc(name).scope, name).toMatch(/^write \(editor\+/);
    expect(toolDoc('keep_version').fields.map((f) => f.name)).toEqual(['app_id', 'version', 'kept']);
    expect(toolDoc('keep_version').description).toContain('APP_VERSIONS_KEPT_MAX');
    const del = toolDoc('delete_versions');
    expect(del.fields.map((f) => f.name)).toEqual(['app_id', 'up_to', 'failed_only', 'user_confirmed']);
    expect(del.description).toMatch(/user_confirmed: true/);
    expect(del.description).toMatch(/ONLY after the user explicitly said yes/);
    expect(del.description).toMatch(/Never delete versions on your own initiative/);
    for (const reason of ['published', 'preview', 'kept', 'rollback_assets', 'newest', 'recent']) expect(del.returns, reason).toContain(reason);
  });

  it('set_gallery_listing lists only on the user\'s explicit yes, with the publish scope', () => {
    const doc = toolDoc('set_gallery_listing');
    expect(doc.scope).toMatch(/^publish\b/);
    expect(doc.description).toMatch(/user_confirmed: true/);
    expect(doc.description).toMatch(/ONLY after the user explicitly said yes/);
    expect(doc.description).toMatch(/Never list an app on your own initiative/);
    expect(doc.fields.map((f) => f.name)).toEqual(['app_id', 'listed', 'description', 'allow_duplicate', 'user_confirmed']);
  });

  it('duplicate_app copies only a duplicable gallery app, with the write scope, never secrets or data', () => {
    const doc = toolDoc('duplicate_app');
    expect(doc.scope).toMatch(/^write\b/);
    expect(doc.description).toMatch(/owner allows duplicates/);
    expect(doc.description).toMatch(/Never copied: secrets, data/);
    expect(doc.fields.map((f) => f.name)).toEqual(['from', 'workspace', 'name']);
  });

  it('set_workspace_publishing is super-admin only and needs the user\'s explicit yes', () => {
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

  it('create_workspace and invite_member mirror the dashboard; the invite needs the user\'s yes and never hands out the link', () => {
    expect(toolDoc('create_workspace').scope).toMatch(/^write \(any signed-in user\)/);
    expect(toolDoc('create_workspace').fields.map((f) => f.name)).toEqual(['name', 'slug']);
    expect(toolDoc('create_workspace').description).toMatch(/slug_taken/);
    const invite = toolDoc('invite_member');
    expect(invite.scope).toMatch(/^write \(workspace-admin role in a team workspace\)/);
    expect(invite.fields.map((f) => f.name)).toEqual(['workspace', 'email', 'role', 'user_confirmed']);
    expect(invite.description).toMatch(/user_confirmed: true/);
    expect(invite.description).toMatch(/ONLY after the user explicitly said yes/);
    expect(invite.description).toMatch(/never through MCP/);
    expect(invite.description).toMatch(/member\.invite/);
    expect(invite.returns).not.toMatch(/url|link|token/);
  });

  it('the super-admin tools: registered for super-admins only, each change on the user\'s explicit yes, audited as the agent', () => {
    for (const name of ['set_workspace_module', 'takedown_app', 'restore_app', 'set_gallery_hidden']) {
      const doc = toolDoc(name);
      expect(doc.scope, name).toMatch(/^(write|publish) \(super-admins of this server only\)/);
      expect(doc.description, name).toMatch(/Only in a super-admin's tools\/list/);
      expect(doc.description, name).toMatch(/user_confirmed: true/);
      expect(doc.description, name).toMatch(/ONLY after the user explicitly said yes/);
      expect(doc.description, name).toMatch(/with you as the actor/);
      expect(doc.fields.at(-1)?.name, name).toBe('user_confirmed');
    }
    expect(toolDoc('set_workspace_module').scope).toMatch(/^write\b/);
    for (const name of ['takedown_app', 'restore_app', 'set_gallery_hidden']) {
      expect(toolDoc(name).scope, name).toMatch(/^publish\b/);
      expect(toolDoc(name).fields[0], name).toMatchObject({ name: 'app', required: true });
    }
    expect(toolDoc('takedown_app').description).toMatch(/Never take an app down on your own initiative/);
    expect(toolDoc('restore_app').description).toMatch(/NOT published again/);
    expect(toolDoc('set_workspace_module').description).toMatch(/module_requires_not_enabled/);
  });

  it('the custom-domain tools mirror the Domains tab; what changes the public site needs the user\'s yes', () => {
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

  it('the member tools mirror the Members tab; removing needs the user\'s explicit yes', () => {
    expect(toolDoc('list_members').scope).toMatch(/^read \(any role/);
    expect(toolDoc('set_member_role').scope).toMatch(/^write \(workspace-admin/);
    expect(toolDoc('remove_member').scope).toMatch(/^write \(workspace-admin role in the workspace; any role to leave\)/);
    expect(toolDoc('list_members').fields.map((f) => f.name)).toEqual(['workspace']);
    expect(toolDoc('set_member_role').fields.map((f) => f.name)).toEqual(['workspace', 'email', 'role']);
    expect(toolDoc('set_member_role').description).not.toMatch(/user_confirmed/);
    const remove = toolDoc('remove_member');
    expect(remove.fields.map((f) => f.name)).toEqual(['workspace', 'email', 'user_confirmed']);
    expect(remove.description).toMatch(/user_confirmed: true/);
    expect(remove.description).toMatch(/ONLY after the user explicitly said yes/);
    for (const name of ['set_member_role', 'remove_member']) {
      expect(toolDoc(name).description, name).toMatch(/last_workspace_admin/);
      expect(toolDoc(name).description, name).toMatch(/personal_workspace/);
      expect(toolDoc(name).returns, name).toContain('released_locks');
    }
  });

  it('delete_workspace needs the user\'s explicit yes, and account deletion stays in the dashboard', () => {
    const doc = toolDoc('delete_workspace');
    expect(doc.scope).toMatch(/^write \(workspace-admin/);
    expect(doc.fields.map((f) => f.name)).toEqual(['workspace', 'user_confirmed']);
    expect(doc.description).toMatch(/user_confirmed: true/);
    expect(doc.description).toMatch(/ONLY after the user explicitly said yes/);
    expect(doc.description).toMatch(/personal_workspace/);
    expect(doc.description).toMatch(/never through MCP/);
    expect(TOOL_NAMES.some((n) => /account/.test(n))).toBe(false);
  });

  it('the app lifecycle tools mirror the Settings tab; what changes the public site needs the user\'s yes', () => {
    for (const name of ['unpublish', 'set_visibility']) expect(toolDoc(name).scope, name).toMatch(/^publish \(editor\+/);
    for (const name of ['set_frame_ancestors', 'release_lease', 'delete_app']) expect(toolDoc(name).scope, name).toMatch(/^write \(editor\+/);
    for (const name of ['unpublish', 'set_visibility', 'delete_app']) {
      const doc = toolDoc(name);
      expect(doc.description, name).toMatch(/user_confirmed: true/);
      expect(doc.description, name).toMatch(/ONLY after the user explicitly said yes/);
      expect(doc.fields.at(-1)?.name, name).toBe('user_confirmed');
    }
    expect(toolDoc('set_visibility').description).toMatch(/never ask for the password in chat/);
    expect(toolDoc('set_visibility').returns).toContain('password_not_set');
    expect(toolDoc('set_visibility').fields.map((f) => f.name)).toEqual(['app_id', 'visibility', 'user_confirmed']);
    expect(toolDoc('set_frame_ancestors').fields.map((f) => f.name)).toEqual(['app_id', 'frame_ancestors']);
    expect(toolDoc('release_lease').description).toMatch(/Only your own lease/);
    expect(toolDoc('release_lease').fields.map((f) => f.name)).toEqual(['app_id']);
    expect(toolDoc('get_app').returns).toContain('visibility:"public"|"password", frame_ancestors:string|null');
  });

  it("the data write tools mirror the Data tab (write scope, editor+); deleting a collection or orphans needs the user's yes", () => {
    const names = ['create_records', 'update_record', 'delete_record', 'delete_collection', 'purge_orphan_records'];
    expect(TOOL_NAMES.slice(TOOL_NAMES.indexOf('query_data') + 1, TOOL_NAMES.indexOf('query_data') + 6)).toEqual(names);
    for (const name of names) {
      const doc = toolDoc(name);
      expect(doc.scope, name).toMatch(/^write \(editor\+/);
      expect(doc.description, name).toMatch(/app_locked_by_admin/);
      expect(doc.description, name).toMatch(/Audited with you as the actor/);
    }
    for (const name of ['delete_collection', 'purge_orphan_records']) {
      const doc = toolDoc(name);
      expect(doc.description, name).toMatch(/user_confirmed: true/);
      expect(doc.description, name).toMatch(/ONLY after the user explicitly said yes/);
      expect(doc.fields.at(-1)?.name, name).toBe('user_confirmed');
    }
    expect(toolDoc('create_records').description).toMatch(/1–500 records per call, stored ALL OR NOTHING/);
    expect(toolDoc('create_records').fields.map((f) => f.name)).toEqual(['app_id', 'collection', 'records']);
    expect(toolDoc('update_record').description).toMatch(/MERGED onto the stored fields/);
    expect(toolDoc('update_record').fields.map((f) => f.name)).toEqual(['app_id', 'collection', 'id', 'fields', 'replace']);
    expect(toolDoc('delete_record').fields.map((f) => f.name)).toEqual(['app_id', 'collection', 'id']);
    expect(toolDoc('delete_collection').description).toMatch(/single-writer lease/);
    expect(toolDoc('purge_orphan_records').fields.map((f) => f.name)).toEqual(['app_id', 'collection', 'user_confirmed']);
  });

  it("the owner's module tabs and the activity log: lists read in an envelope, changes write; signing everyone out and removing a secret need the user's yes", () => {
    const names = [
      'list_form_submissions',
      'delete_form_submission',
      'list_end_users',
      'set_end_user_role',
      'set_end_user_blocked',
      'sign_out_end_users',
      'list_uploads',
      'delete_upload',
      'remove_module_secret',
      'list_activity',
    ];
    const at = TOOL_NAMES.indexOf('list_form_submissions');
    expect(TOOL_NAMES.slice(at, at + names.length)).toEqual(names);
    for (const name of ['list_form_submissions', 'list_end_users', 'list_uploads']) {
      expect(toolDoc(name).scope, name).toMatch(/^read \(viewer\+/);
      expect(toolDoc(name).description, name).toMatch(/at most 100 \w+ and 64 KiB per call/i);
      expect(toolDoc(name).fields.map((f) => f.name).slice(-2), name).toEqual(['limit', 'cursor']);
    }
    expect(toolDoc('list_activity').scope).toMatch(/^read \(workspace-admin/);
    expect(toolDoc('list_activity').fields.map((f) => f.name)).toEqual(['workspace', 'app', 'action', 'actor', 'from', 'to', 'limit', 'cursor']);
    for (const name of ['delete_form_submission', 'set_end_user_role', 'set_end_user_blocked', 'sign_out_end_users', 'delete_upload', 'remove_module_secret']) {
      expect(toolDoc(name).scope, name).toMatch(/^write \(editor\+/);
      expect(toolDoc(name).description, name).toMatch(/with you as the actor/);
    }
    for (const name of ['sign_out_end_users', 'remove_module_secret']) {
      const doc = toolDoc(name);
      expect(doc.description, name).toMatch(/user_confirmed: true/);
      expect(doc.description, name).toMatch(/ONLY after the user explicitly said yes/);
      expect(doc.fields.at(-1)?.name, name).toBe('user_confirmed');
    }
    expect(toolDoc('list_end_users').description).toMatch(/personal data/);
    expect(toolDoc('set_end_user_role').returns).not.toContain('email');
    expect(toolDoc('set_end_user_blocked').returns).not.toContain('email');
    expect(toolDoc('remove_module_secret').description).toMatch(/Setting a value stays in the dashboard/);
    expect(toolDoc('list_uploads').description).toMatch(/not available over MCP/);
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
    // The untrusted tools answer text only — no structuredContent past the envelope.
    for (const name of ['read_file', 'query_data', 'get_logs', 'list_form_submissions', 'list_end_users', 'list_uploads', 'list_activity']) {
      expect(toolDoc(name).description, name).toMatch(/no structuredContent/);
      expect(toolDoc(name).returns, name).toMatch(/^text only/);
    }
  });

  it('read_file reads several paths or a line range, or searches literal text, all read-only', () => {
    const doc = toolDoc('read_file');
    expect(doc.scope).toMatch(/^read\b/);
    expect(doc.fields.map((f) => f.name)).toEqual(['app_id', 'path', 'paths', 'version', 'offset', 'limit', 'search', 'ignore_case']);
    expect(doc.fields.filter((f) => f.required).map((f) => f.name)).toEqual(['app_id']);
    expect(doc.description).toContain('`paths` up to 20');
    expect(doc.description).toContain('COMPILE_MAX_FILE_BYTES');
    expect(doc.description).toContain('`omitted`');
    expect(doc.description).toContain('literal text, not a regex');
    expect(doc.returns).toContain('<untrusted-app-search');
    expect(doc.returns).toContain('total_lines');
  });

  it('skill_info never returns secrets; configure_module routes secrets to the dashboard', () => {
    expect(toolDoc('skill_info').scope).toMatch(/^read\b/);
    expect(toolDoc('skill_info').description).toMatch(/Never returns secret values or any app's config/);
    expect(toolDoc('configure_module').scope).toMatch(/^write\b/);
    expect(toolDoc('configure_module').description).toMatch(/confirm_url/);
    expect(toolDoc('configure_module').description).toMatch(/Secrets are never set here/);
  });

  it('query_data reads (≤ 100 records) and marks the records untrusted', () => {
    expect(toolDoc('query_data').scope).toMatch(/^read\b/);
    expect(toolDoc('query_data').description).toMatch(/untrusted/);
    expect(toolDoc('query_data').description).toMatch(/at most 100 records/);
    expect(toolDoc('query_data').returns).toContain('untrusted:true');
  });

  it('get_logs reads runtime / compile / requests and marks the entries untrusted', () => {
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
