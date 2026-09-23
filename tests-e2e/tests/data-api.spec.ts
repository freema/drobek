import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';
import { seedApp, workspaceIdBySlug } from './helpers/seed';

/**
 * U10 acceptance (PHY-55 / PHY-56; PHY-63/71): drive the Data API as an MCP
 * client — collection_define with a JSON Schema → schema-honoring writes; an
 * invalid doc is rejected (validation_failed); record read/update/delete/query
 * round-trip. Quota caps create; a cross-workspace locator is rejected (tenant
 * isolation). The app the collections attach to is SEEDED via SQL (apps are no
 * longer created by an MCP deploy). Requires the local compose stack.
 */

const DATA_SCOPE = 'mcp:whoami apps:read data:read data:write';

/** Login + consent(data:read/write) + connected MCP client. */
async function dataClient(
  page: Page,
  request: APIRequestContext,
  tag: string
): Promise<McpClient> {
  return mcpClient(page, request, { tag, scope: DATA_SCOPE });
}

const TODO_SCHEMA = {
  type: 'object',
  required: ['title', 'done'],
  properties: {
    title: { type: 'string' },
    done: { type: 'boolean' },
    priority: { type: 'number' },
  },
  additionalProperties: false,
};

/** Seed a throwaway app in the token's workspace so the data tools can resolve it. */
async function freshApp(
  mcp: McpClient
): Promise<{ workspace: string; slug: string }> {
  const app = await seedApp({ workspaceId: await workspaceIdBySlug(mcp.workspace) });
  return { workspace: mcp.workspace, slug: app.slug };
}

test('collection_define + schema-honoring CRUD round-trip via MCP @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const mcp = await dataClient(page, request, 'data-crud');
  const { client, transport } = mcp;
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('collection_define');
    expect(tools).toContain('record_create');
    expect(tools).toContain('record_read');
    expect(tools).toContain('record_update');
    expect(tools).toContain('record_delete');
    expect(tools).toContain('record_query');
    const who = await callTool(client, 'whoami', {});
    expect(who.json.scope, 'data scopes granted').toContain('data:write');

    const app = await freshApp(mcp);
    const locator = { workspace: app.workspace, slug: app.slug };

    const def = await callTool(client, 'collection_define', {
      workspace: app.workspace,
      slug: app.slug,
      name: 'todos',
      jsonSchema: TODO_SCHEMA,
      accessMode: 'locked',
    });
    expect(def.isError, JSON.stringify(def.json)).toBe(false);

    // A schema-honoring doc is accepted.
    const created = await callTool(client, 'record_create', {
      locator,
      collection: 'todos',
      doc: { title: 'ship U10', done: false, priority: 1 },
    });
    expect(created.isError, JSON.stringify(created.json)).toBe(false);
    const id = created.json.id as string;
    expect(id).toBeTruthy();

    // An INVALID doc (missing required `done`) is rejected as validation_failed.
    const missing = await callTool(client, 'record_create', {
      locator,
      collection: 'todos',
      doc: { title: 'no done flag' },
    });
    expect(missing.isError).toBe(true);
    expect(missing.json.error).toBe('validation_failed');

    // A wrong-typed field is rejected too.
    const wrongType = await callTool(client, 'record_create', {
      locator,
      collection: 'todos',
      doc: { title: 42, done: true },
    });
    expect(wrongType.isError).toBe(true);
    expect(wrongType.json.error).toBe('validation_failed');

    // read
    const read = await callTool(client, 'record_read', {
      locator,
      collection: 'todos',
      id,
    });
    expect(read.isError, JSON.stringify(read.json)).toBe(false);
    expect((read.json.doc as { title: string }).title).toBe('ship U10');

    // update (shallow-merge → re-validated)
    const updated = await callTool(client, 'record_update', {
      locator,
      collection: 'todos',
      id,
      patch: { done: true },
    });
    expect(updated.isError, JSON.stringify(updated.json)).toBe(false);
    expect((updated.json.doc as { done: boolean }).done).toBe(true);

    // query (equality filter on a schema field)
    const q = await callTool(client, 'record_query', {
      locator,
      collection: 'todos',
      where: { done: true },
    });
    expect(q.isError, JSON.stringify(q.json)).toBe(false);
    const records = q.json.records as { id: string }[];
    expect(records.some((r) => r.id === id)).toBe(true);

    // an unknown query field is rejected (whitelist / no injection)
    const badField = await callTool(client, 'record_query', {
      locator,
      collection: 'todos',
      where: { ssn: '123' },
    });
    expect(badField.isError).toBe(true);
    expect(badField.json.error).toBe('invalid_request');

    // delete → soft-delete → excluded from subsequent read + query
    const del = await callTool(client, 'record_delete', {
      locator,
      collection: 'todos',
      id,
    });
    expect(del.isError, JSON.stringify(del.json)).toBe(false);

    const readGone = await callTool(client, 'record_read', {
      locator,
      collection: 'todos',
      id,
    });
    expect(readGone.isError).toBe(true);
    expect(readGone.json.error).toBe('not_found');

    const qGone = await callTool(client, 'record_query', {
      locator,
      collection: 'todos',
      where: { done: true },
    });
    expect((qGone.json.records as { id: string }[]).some((r) => r.id === id)).toBe(
      false
    );
  } finally {
    await transport.close();
  }
});

test('quota: exceeding DATA_MAX_DOCS_PER_APP rejects the create @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const mcp = await dataClient(page, request, 'data-quota');
  const { client, transport } = mcp;
  try {
    const app = await freshApp(mcp);
    const locator = { workspace: app.workspace, slug: app.slug };
    await callTool(client, 'collection_define', {
      workspace: app.workspace,
      slug: app.slug,
      name: 'capped',
      jsonSchema: TODO_SCHEMA,
      accessMode: 'locked',
    });

    // The dev compose caps DATA_MAX_DOCS_PER_APP at 5 → the 6th create fails.
    let rejected = false;
    let rejectionCode: unknown;
    for (let i = 0; i < 20; i++) {
      const res = await callTool(client, 'record_create', {
        locator,
        collection: 'capped',
        doc: { title: `doc ${i}`, done: false },
      });
      if (res.isError) {
        rejected = true;
        rejectionCode = res.json.error;
        break;
      }
    }
    expect(rejected, 'a create was eventually rejected by the quota').toBe(true);
    expect(rejectionCode).toBe('too_many_docs');
  } finally {
    await transport.close();
  }
});

test('tenant isolation: a record op on another workspace than the token is rejected @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  // Client A (this page), bound to A's personal workspace.
  const a = await dataClient(page, request, 'data-tenant-a');
  // Client B in an isolated browser context → a different user/workspace.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const b = await dataClient(pageB, request, 'data-tenant-b');
  try {
    expect(a.workspace).not.toBe(b.workspace);
    const appB = await freshApp(b);
    // B defines a collection in B's workspace.
    const defB = await callTool(b.client, 'collection_define', {
      workspace: appB.workspace,
      slug: appB.slug,
      name: 'secrets',
      jsonSchema: TODO_SCHEMA,
      accessMode: 'locked',
    });
    expect(defB.isError, JSON.stringify(defB.json)).toBe(false);

    // A (bound to workspace A) targets B's locator → rejected (not found).
    const cross = await callTool(a.client, 'record_create', {
      locator: { workspace: appB.workspace, slug: appB.slug },
      collection: 'secrets',
      doc: { title: 'steal', done: true },
    });
    expect(cross.isError, 'cross-workspace write must be rejected').toBe(true);
    expect(cross.json.error).toBe('not_found');
  } finally {
    await a.transport.close();
    await b.transport.close();
    await pageB.close();
    await ctxB.close();
  }
});
