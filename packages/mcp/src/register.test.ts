/**
 * tools/list snapshot (M0-05 + M0-06 + M1-01 + M1-03 + M1-07 + NSO-340 + NSO-358): exactly the 15 tools, in order, with
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

async function listTools(allow?: (t: string) => boolean) {
  const server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
  registerAppTools(server, principal, { deps: testDeps(), allow });
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
  it('is exactly the 15 tools with their annotations and inputs (snapshot)', async () => {
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
        properties: ['app_id', 'listed', 'description', 'user_confirmed'],
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
    ]);
    const create = tools.find((t) => t.name === 'create_app')!;
    expect((create.inputSchema.properties as Record<string, { enum?: string[] }>).template.enum).toEqual([
      'react-ts',
      'html',
    ]);
    for (const t of tools) expect(t.description!.length, t.name).toBeGreaterThan(40);
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
