/**
 * tools/list snapshot (M0-05 + M0-06 + M1-01 + M1-03 + M1-07 + NSO-340 + NSO-358 + the domain tools of NSO-366): exactly the 20 tools of a
 * user who is not a super-admin (a super-admin also gets set_workspace_publishing, NSO-366), in order, with
 * their titles, annotations and input schemas. Hand-written on purpose — a
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
  it('is exactly the 24 tools with their annotations and inputs (snapshot)', async () => {
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
        title: 'Read a file',
        annotations: { title: 'Read a file', ...RO },
        properties: ['app_id', 'path', 'version'],
        required: ['app_id', 'path'],
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
        name: 'get_logs',
        title: "Read an app's logs",
        annotations: { title: "Read an app's logs", ...RO },
        properties: ['app_id', 'kind', 'since'],
        required: ['app_id', 'kind'],
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
    ]);
    const create = tools.find((t) => t.name === 'create_app')!;
    expect((create.inputSchema.properties as Record<string, { enum?: string[] }>).template.enum).toEqual([
      'react-ts',
      'html',
    ]);
    for (const t of tools) expect(t.description!.length, t.name).toBeGreaterThan(40);
  });

  it('a super-admin also gets set_workspace_publishing, last (NSO-366)', async () => {
    const tools = await listTools(undefined, true);
    expect(tools).toHaveLength(25);
    const last = tools[24];
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
