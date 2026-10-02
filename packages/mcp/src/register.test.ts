/**
 * tools/list snapshot: exactly the 47 tools of a user who is not a
 * super-admin (a super-admin also gets set_workspace_publishing,
 * set_workspace_module, takedown_app, restore_app and set_gallery_hidden), in order,
 * with their titles, annotations and input schemas. Hand-written on purpose — a
 * change to the public tool surface must be a deliberate edit here.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { registerAppTools } from './register.js';
import { testDeps } from './test/harness.js';

const principal = { userId: 'u', email: 'u@example.test', superAdmin: false };

async function listTools(allow?: (t: string) => boolean, superAdmin = false) {
  const server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
  registerAppTools(server, { ...principal, superAdmin }, { deps: testDeps(), allow });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(c);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

describe('tools/list', () => {
  it('is exactly the 47 tools with their annotations and inputs (snapshot)', async () => {
    const tools = await listTools();
    const snapshot = tools.map((t) => ({
      name: t.name,
      title: t.title,
      annotations: t.annotations,
      properties: Object.keys((t.inputSchema.properties ?? {}) as object),
      required: t.inputSchema.required ?? [],
    }));
    expect(snapshot).toEqual([
      {
        name: 'list_apps',
        title: 'List apps',
        annotations: { title: 'List apps', ...RO },
        properties: ['workspace'],
        required: [],
      },
      {
        name: 'create_app',
        title: 'Create an app',
        annotations: { title: 'Create an app', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        properties: ['name', 'workspace', 'template'],
        required: ['name'],
      },
      {
        name: 'duplicate_app',
        title: 'Duplicate a gallery app',
        annotations: { title: 'Duplicate a gallery app', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        properties: ['from', 'workspace', 'name'],
        required: ['from'],
      },
      {
        name: 'get_app',
        title: 'Get an app',
        annotations: { title: 'Get an app', ...RO },
        properties: ['app_id'],
        required: ['app_id'],
      },
      {
        name: 'read_file',
        title: 'Read or search files',
        annotations: { title: 'Read or search files', ...RO },
        properties: ['app_id', 'path', 'paths', 'version', 'offset', 'limit', 'search', 'ignore_case'],
        required: ['app_id'],
      },
      {
        name: 'write_files',
        title: 'Write files (new version)',
        annotations: {
          title: 'Write files (new version)',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        properties: ['app_id', 'files', 'reasoning'],
        required: ['app_id', 'files', 'reasoning'],
      },
      {
        name: 'restore_version',
        title: 'Restore a version',
        annotations: {
          title: 'Restore a version',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        properties: ['app_id', 'version'],
        required: ['app_id', 'version'],
      },
      {
        name: 'publish',
        title: 'Publish a version',
        annotations: {
          title: 'Publish a version',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        properties: ['app_id', 'version'],
        required: ['app_id'],
      },
      {
        name: 'set_gallery_listing',
        title: 'List an app in the public gallery',
        annotations: {
          title: 'List an app in the public gallery',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        properties: ['app_id', 'listed', 'description', 'allow_duplicate', 'user_confirmed'],
        required: ['app_id', 'listed'],
      },
      {
        name: 'unpublish',
        title: 'Unpublish an app',
        annotations: { title: 'Unpublish an app', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        properties: ['app_id', 'user_confirmed'],
        required: ['app_id'],
      },
      {
        name: 'set_visibility',
        title: 'Set who can open an app',
        annotations: { title: 'Set who can open an app', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        properties: ['app_id', 'visibility', 'user_confirmed'],
        required: ['app_id', 'visibility'],
      },
      {
        name: 'set_frame_ancestors',
        title: 'Set which sites may embed an app',
        annotations: { title: 'Set which sites may embed an app', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        properties: ['app_id', 'frame_ancestors'],
        required: ['app_id', 'frame_ancestors'],
      },
      {
        name: 'release_lease',
        title: 'Release your write lease',
        annotations: { title: 'Release your write lease', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        properties: ['app_id'],
        required: ['app_id'],
      },
      {
        name: 'delete_app',
        title: 'Delete an app',
        annotations: { title: 'Delete an app', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        properties: ['app_id', 'user_confirmed'],
        required: ['app_id'],
      },
      {
        name: 'skill_info',
        title: 'Read a skill',
        annotations: { title: 'Read a skill', ...RO },
        properties: ['name', 'app_id'],
        required: [],
      },
      {
        name: 'configure_module',
        title: 'Configure a platform module',
        annotations: {
          title: 'Configure a platform module',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        properties: ['app_id', 'module', 'config'],
        required: ['app_id', 'module', 'config'],
      },
      {
        name: 'query_data',
        title: "Query an app's data",
        annotations: { title: "Query an app's data", ...RO },
        properties: ['app_id', 'collection', 'filter', 'sort', 'dir', 'limit', 'cursor'],
        required: ['app_id', 'collection'],
      },
      {
        name: 'create_records',
        title: 'Add records to a collection',
        annotations: { title: 'Add records to a collection', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        properties: ['app_id', 'collection', 'records'],
        required: ['app_id', 'collection', 'records'],
      },
      {
        name: 'update_record',
        title: 'Change a record',
        annotations: { title: 'Change a record', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['app_id', 'collection', 'id', 'fields', 'replace'],
        required: ['app_id', 'collection', 'id', 'fields'],
      },
      {
        name: 'delete_record',
        title: 'Delete a record',
        annotations: { title: 'Delete a record', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['app_id', 'collection', 'id'],
        required: ['app_id', 'collection', 'id'],
      },
      {
        name: 'delete_collection',
        title: 'Delete a collection',
        annotations: { title: 'Delete a collection', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['app_id', 'collection', 'user_confirmed'],
        required: ['app_id', 'collection'],
      },
      {
        name: 'purge_orphan_records',
        title: 'Purge orphan records',
        annotations: { title: 'Purge orphan records', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['app_id', 'collection', 'user_confirmed'],
        required: ['app_id'],
      },
      {
        name: 'get_logs',
        title: "Read an app's logs",
        annotations: { title: "Read an app's logs", ...RO },
        properties: ['app_id', 'kind', 'since'],
        required: ['app_id', 'kind'],
      },
      {
        name: 'sync_now',
        title: 'Run a sync source now',
        annotations: { title: 'Run a sync source now', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        properties: ['app_id', 'source'],
        required: ['app_id', 'source'],
      },
      {
        name: 'create_asset_upload',
        title: 'Get an upload URL for a big file',
        annotations: {
          title: 'Get an upload URL for a big file',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        properties: ['app_id', 'path', 'size', 'content_type'],
        required: ['app_id', 'path', 'size'],
      },
      {
        name: 'list_assets',
        title: "List an app's uploaded files",
        annotations: { title: "List an app's uploaded files", ...RO },
        properties: ['app_id'],
        required: ['app_id'],
      },
      {
        name: 'delete_asset',
        title: 'Delete an uploaded file',
        annotations: {
          title: 'Delete an uploaded file',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        properties: ['app_id', 'path'],
        required: ['app_id', 'path'],
      },
      {
        name: 'list_form_submissions',
        title: "List an app's form submissions",
        annotations: { title: "List an app's form submissions", ...RO },
        properties: ['app_id', 'form', 'from', 'to', 'limit', 'cursor'],
        required: ['app_id'],
      },
      {
        name: 'delete_form_submission',
        title: 'Delete a form submission',
        annotations: { title: 'Delete a form submission', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['app_id', 'id'],
        required: ['app_id', 'id'],
      },
      {
        name: 'list_end_users',
        title: "List an app's end users",
        annotations: { title: "List an app's end users", ...RO },
        properties: ['app_id', 'search', 'limit', 'cursor'],
        required: ['app_id'],
      },
      {
        name: 'set_end_user_role',
        title: "Change an end user's role",
        annotations: { title: "Change an end user's role", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['app_id', 'user_id', 'role'],
        required: ['app_id', 'user_id', 'role'],
      },
      {
        name: 'set_end_user_blocked',
        title: 'Block or unblock an end user',
        annotations: { title: 'Block or unblock an end user', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['app_id', 'user_id', 'blocked'],
        required: ['app_id', 'user_id', 'blocked'],
      },
      {
        name: 'sign_out_end_users',
        title: 'Sign every end user out',
        annotations: { title: 'Sign every end user out', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        properties: ['app_id', 'user_confirmed'],
        required: ['app_id'],
      },
      {
        name: 'list_uploads',
        title: "List an app's end-user uploads",
        annotations: { title: "List an app's end-user uploads", ...RO },
        properties: ['app_id', 'limit', 'cursor'],
        required: ['app_id'],
      },
      {
        name: 'delete_upload',
        title: 'Delete an end-user upload',
        annotations: { title: 'Delete an end-user upload', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['app_id', 'id'],
        required: ['app_id', 'id'],
      },
      {
        name: 'remove_module_secret',
        title: 'Remove a module secret',
        annotations: { title: 'Remove a module secret', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['app_id', 'module', 'name', 'user_confirmed'],
        required: ['app_id', 'module', 'name'],
      },
      {
        name: 'list_activity',
        title: "Read a workspace's activity log",
        annotations: { title: "Read a workspace's activity log", ...RO },
        properties: ['workspace', 'app', 'action', 'actor', 'from', 'to', 'limit', 'cursor'],
        required: ['workspace'],
      },
      {
        name: 'list_domains',
        title: "List an app's custom domains",
        annotations: { title: "List an app's custom domains", ...RO },
        properties: ['app_id'],
        required: ['app_id'],
      },
      {
        name: 'add_domain',
        title: 'Add a custom domain',
        annotations: { title: 'Add a custom domain', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        properties: ['app_id', 'host'],
        required: ['app_id', 'host'],
      },
      {
        name: 'verify_domain',
        title: 'Verify a custom domain',
        annotations: { title: 'Verify a custom domain', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        properties: ['app_id', 'host'],
        required: ['app_id', 'host'],
      },
      {
        name: 'set_primary_domain',
        title: 'Set the primary custom domain',
        annotations: {
          title: 'Set the primary custom domain',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        properties: ['app_id', 'host', 'user_confirmed'],
        required: ['app_id', 'host'],
      },
      {
        name: 'remove_domain',
        title: 'Remove a custom domain',
        annotations: { title: 'Remove a custom domain', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        properties: ['app_id', 'host', 'user_confirmed'],
        required: ['app_id', 'host'],
      },
      {
        name: 'list_upstreams',
        title: 'List a workspace\'s proxy upstreams',
        annotations: { title: 'List a workspace\'s proxy upstreams', ...RO },
        properties: ['workspace'],
        required: ['workspace'],
      },
      {
        name: 'register_upstream',
        title: 'Register a proxy upstream',
        annotations: { title: 'Register a proxy upstream', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        properties: ['workspace', 'name', 'base_url', 'allowed_methods', 'allowed_path_prefixes', 'auth_type', 'auth_header_name'],
        required: ['workspace', 'name', 'base_url', 'allowed_methods', 'allowed_path_prefixes', 'auth_type'],
      },
      {
        name: 'remove_upstream',
        title: 'Remove a proxy upstream',
        annotations: { title: 'Remove a proxy upstream', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['workspace', 'name', 'user_confirmed'],
        required: ['workspace', 'name'],
      },
      {
        name: 'create_workspace',
        title: 'Create a team workspace',
        annotations: { title: 'Create a team workspace', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        properties: ['name', 'slug'],
        required: ['name', 'slug'],
      },
      {
        name: 'list_members',
        title: 'List a workspace\'s members',
        annotations: { title: 'List a workspace\'s members', ...RO },
        properties: ['workspace'],
        required: ['workspace'],
      },
      {
        name: 'invite_member',
        title: 'Invite a workspace member',
        annotations: { title: 'Invite a workspace member', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        properties: ['workspace', 'email', 'role', 'user_confirmed'],
        required: ['workspace', 'email', 'role'],
      },
      {
        name: 'set_member_role',
        title: 'Change a member\'s role',
        annotations: { title: 'Change a member\'s role', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        properties: ['workspace', 'email', 'role'],
        required: ['workspace', 'email', 'role'],
      },
      {
        name: 'remove_member',
        title: 'Remove a member from a workspace',
        annotations: { title: 'Remove a member from a workspace', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['workspace', 'email', 'user_confirmed'],
        required: ['workspace', 'email'],
      },
      {
        name: 'delete_workspace',
        title: 'Delete a team workspace',
        annotations: { title: 'Delete a team workspace', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        properties: ['workspace', 'user_confirmed'],
        required: ['workspace'],
      },
    ]);
    const create = tools.find((t) => t.name === 'create_app')!;
    expect((create.inputSchema.properties as Record<string, { enum?: string[] }>).template.enum).toEqual([
      'react-ts',
      'html',
    ]);
    for (const t of tools) expect(t.description!.length, t.name).toBeGreaterThan(40);
    const visibility = tools.find((t) => t.name === 'set_visibility')!;
    expect((visibility.inputSchema.properties as Record<string, { enum?: string[] }>).visibility.enum).toEqual(['public', 'password']);
    const invite = tools.find((t) => t.name === 'invite_member')!;
    expect((invite.inputSchema.properties as Record<string, { enum?: string[] }>).role.enum).toEqual(['viewer', 'editor', 'workspace-admin']);
  });

  it('a super-admin also gets set_workspace_publishing, set_workspace_module and the moderation tools, last', async () => {
    const tools = await listTools(undefined, true);
    expect(tools).toHaveLength(56);
    expect(tools.slice(51).map((t) => t.name)).toEqual(['set_workspace_publishing', 'set_workspace_module', 'takedown_app', 'restore_app', 'set_gallery_hidden']);
    const props = (name: string) => Object.keys((tools.find((t) => t.name === name)!.inputSchema.properties ?? {}) as object);
    expect(props('set_workspace_module')).toEqual(['workspace', 'module', 'enabled', 'user_confirmed']);
    expect(props('takedown_app')).toEqual(['app', 'reason', 'user_confirmed']);
    expect(props('restore_app')).toEqual(['app', 'user_confirmed']);
    expect(props('set_gallery_hidden')).toEqual(['app', 'hidden', 'user_confirmed']);
    const takedown = tools.find((t) => t.name === 'takedown_app')!;
    expect((takedown.inputSchema.properties as Record<string, { enum?: string[] }>).reason.enum).toEqual(['phishing', 'malware', 'spam', 'copyright', 'illegal', 'other']);
    const last = tools[51];
    expect(last.name).toBe('set_workspace_publishing');
    expect(last.annotations).toEqual({
      title: 'Set a workspace\'s publishing',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(Object.keys((last.inputSchema.properties ?? {}) as object)).toEqual(['workspace', 'publishing', 'user_confirmed']);
    expect(last.inputSchema.required).toEqual(['workspace', 'publishing']);
    expect((last.inputSchema.properties as Record<string, { enum?: string[] }>).publishing.enum).toEqual(['default', 'allowed', 'blocked']);
  });

  it('lists every input schema as a plain object schema, without additionalProperties (the wire JSON)', async () => {
    const tools = JSON.parse(JSON.stringify(await listTools(undefined, true))) as { name: string; inputSchema: Record<string, unknown> }[];
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(Object.keys(t.inputSchema).sort(), t.name).toEqual(
        ['$schema', 'properties', 'required', 'type'].filter((k) => k in t.inputSchema)
      );
      expect('additionalProperties' in t.inputSchema, t.name).toBe(false);
    }
  });

  it('registers only what `allow` lets through (the scope gate)', async () => {
    const tools = await listTools((t) => t === 'get_app' || t === 'read_file');
    expect(tools.map((t) => t.name)).toEqual(['get_app', 'read_file']);
  });
});

describe('a grant with no tool scope', () => {
  it('still answers tools/list with an empty list', async () => {
    expect(await listTools(() => false)).toEqual([]);
  });
});
