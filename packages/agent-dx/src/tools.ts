/**
 * TOOL_DOCS — the declarative documentation manifest for the drobek MCP tools
 * (M1b Agent DX, PHY-124). This is the SINGLE SOURCE OF TRUTH the agent-facing
 * docs render from (llms.txt / llms-full.txt / MCP docs resources), so the
 * published schemas cannot silently drift from the real tools.
 *
 * The actual zod input schemas + scope gating live in the MCP server
 * registrations (@drobek/oauth/resource/mcp.ts). This manifest is kept in
 * PARITY with those registrations by a drift-guard unit test in @drobek/oauth
 * (tool-docs-parity.test.ts): it builds a full-scope MCP server and asserts the
 * set of ACTUALLY registered tool names EQUALS `TOOL_NAMES` below. A future tool
 * added without a doc here (or a doc for a tool that no longer exists) fails CI.
 *
 * MAINTENANCE RULE: any change to the MCP tool surface (a new/removed tool, a
 * renamed field, a changed scope) updates THIS manifest + the drobek skill in
 * the SAME PR. The drift-guard test enforces the tool-name half automatically.
 */

/** One input field of a tool, described for a human/agent reader. */
export interface ToolField {
  name: string;
  /** Human-readable type, e.g. `string`, `string (optional)`, `{path,sha256,bytes}[]`. */
  type: string;
  required: boolean;
  description: string;
}

/** A single documented MCP tool. */
export interface ToolDoc {
  /** Tool name — MUST match the MCP registration exactly (drift-guarded). */
  name: string;
  title: string;
  /** Human-readable scope/role requirement. */
  scope: string;
  description: string;
  fields: ToolField[];
  /** One concrete example call (the `arguments` object passed to the tool). */
  example: Record<string, unknown>;
}

export const TOOL_DOCS: ToolDoc[] = [
  {
    name: 'whoami',
    title: 'Who am I',
    scope: 'always available (mcp:whoami)',
    description:
      'Return the authenticated drobek user, the bound workspace + role, and the granted MCP scope. Call this first to learn your workspace slug — you need it for the data tools.',
    fields: [],
    example: {},
  },
  {
    name: 'list_apps',
    title: 'List apps',
    scope: 'apps:read',
    description:
      'List the apps in the bound workspace (slug, status, visibility, createdAt). May be empty.',
    fields: [],
    example: {},
  },
  {
    name: 'collection_define',
    title: 'Define a collection',
    scope: 'data:write (editor+ role)',
    description:
      'Create or update a collection: a REQUIRED JSON Schema (every write is validated against it) and an access mode (public-read | public-write | locked | owner-only). Idempotent by (app, name). Define this FIRST, then write your app code against the schema. owner-only is reserved for U11 end-user auth.',
    fields: [
      { name: 'workspace', type: 'string', required: true, description: 'Workspace slug (from whoami).' },
      { name: 'slug', type: 'string', required: true, description: 'App slug.' },
      { name: 'name', type: 'string', required: true, description: 'Collection name (unique within the app).' },
      { name: 'jsonSchema', type: 'object (JSON Schema)', required: true, description: 'The JSON Schema every document is validated against.' },
      { name: 'accessMode', type: '"public-read" | "public-write" | "locked" | "owner-only"', required: true, description: 'Who may read/write anonymously (see access modes).' },
    ],
    example: {
      workspace: 'acme',
      slug: 'my-todo',
      name: 'todos',
      jsonSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, done: { type: 'boolean' } },
        required: ['title'],
        additionalProperties: false,
      },
      accessMode: 'public-write',
    },
  },
  {
    name: 'record_create',
    title: 'Create a document',
    scope: 'data:write',
    description:
      'Create a document in a collection. Validated against the collection JSON Schema (invalid → rejected), rate-limited, and quota-capped. Returns the stored document { id, ...doc, createdAt, updatedAt }.',
    fields: [
      { name: 'locator', type: '{ workspace, slug }', required: true, description: 'Workspace slug + app slug.' },
      { name: 'collection', type: 'string', required: true, description: 'Collection name.' },
      { name: 'doc', type: 'object', required: true, description: 'The document body (must satisfy the schema).' },
    ],
    example: {
      locator: { workspace: 'acme', slug: 'my-todo' },
      collection: 'todos',
      doc: { title: 'Buy milk', done: false },
    },
  },
  {
    name: 'record_read',
    title: 'Read a document',
    scope: 'data:read',
    description: 'Read a single document by id from a collection.',
    fields: [
      { name: 'locator', type: '{ workspace, slug }', required: true, description: 'Workspace slug + app slug.' },
      { name: 'collection', type: 'string', required: true, description: 'Collection name.' },
      { name: 'id', type: 'string', required: true, description: 'Document id.' },
    ],
    example: {
      locator: { workspace: 'acme', slug: 'my-todo' },
      collection: 'todos',
      id: 'rec_01hzz…',
    },
  },
  {
    name: 'record_update',
    title: 'Update a document',
    scope: 'data:write',
    description:
      'Patch a document (shallow-merge into the existing doc); the merged document is re-validated against the schema.',
    fields: [
      { name: 'locator', type: '{ workspace, slug }', required: true, description: 'Workspace slug + app slug.' },
      { name: 'collection', type: 'string', required: true, description: 'Collection name.' },
      { name: 'id', type: 'string', required: true, description: 'Document id.' },
      { name: 'patch', type: 'object', required: true, description: 'Fields to shallow-merge into the document.' },
    ],
    example: {
      locator: { workspace: 'acme', slug: 'my-todo' },
      collection: 'todos',
      id: 'rec_01hzz…',
      patch: { done: true },
    },
  },
  {
    name: 'record_delete',
    title: 'Delete a document',
    scope: 'data:write',
    description:
      'Soft-delete a document (excluded from every subsequent read/query; the row is retained).',
    fields: [
      { name: 'locator', type: '{ workspace, slug }', required: true, description: 'Workspace slug + app slug.' },
      { name: 'collection', type: 'string', required: true, description: 'Collection name.' },
      { name: 'id', type: 'string', required: true, description: 'Document id.' },
    ],
    example: {
      locator: { workspace: 'acme', slug: 'my-todo' },
      collection: 'todos',
      id: 'rec_01hzz…',
    },
  },
  {
    name: 'record_query',
    title: 'Query a collection',
    scope: 'data:read',
    description:
      'Query a collection: `where` equality filters + `sort` (both restricted to the schema properties + createdAt/updatedAt/id — unknown fields rejected), `limit`, and an opaque `cursor` for pagination. Soft-deleted docs are excluded. Returns { records:[…], nextCursor }.',
    fields: [
      { name: 'locator', type: '{ workspace, slug }', required: true, description: 'Workspace slug + app slug.' },
      { name: 'collection', type: 'string', required: true, description: 'Collection name.' },
      { name: 'where', type: 'object (optional)', required: false, description: 'Equality filters keyed by schema field.' },
      { name: 'sort', type: '{ field, dir? } (optional)', required: false, description: 'Sort by a schema field or createdAt/updatedAt/id; dir asc|desc.' },
      { name: 'limit', type: 'number (optional)', required: false, description: 'Page size.' },
      { name: 'cursor', type: 'string (optional)', required: false, description: 'Opaque cursor from a prior page (nextCursor).' },
    ],
    example: {
      locator: { workspace: 'acme', slug: 'my-todo' },
      collection: 'todos',
      where: { done: false },
      sort: { field: 'createdAt', dir: 'desc' },
      limit: 20,
    },
  },
  {
    name: 'app_errors',
    title: 'Read app errors',
    scope: 'apps:read',
    description:
      'Read the recent client-side errors captured for an app (window.onerror + unhandledrejection), DEDUPED by message + stack head with occurrence counts, first/last-seen, the last URL, and a file:line hint. Call this after a change (once a user has hit the app) to close the write→observe→fix loop and self-correct. Read-only. Returns { workspace, app, totalEvents, distinctErrors, errors:[{ dedupKey, type, message, count, firstSeen, lastSeen, lastUrl, fileHint }] }.',
    fields: [
      { name: 'workspace', type: 'string', required: true, description: 'Workspace slug (from whoami).' },
      { name: 'slug', type: 'string', required: true, description: 'App slug.' },
      { name: 'since', type: 'string (ISO datetime, optional)', required: false, description: 'Only errors at/after this time; defaults to the last 14 days.' },
    ],
    example: { workspace: 'acme', slug: 'my-todo' },
  },
  {
    name: 'app_logs',
    title: 'Read app serving signals',
    scope: 'apps:read',
    description:
      'Read the server-side serving signals for an app: request volume, 5xx count, the top 404-by-path (missing assets/routes — a common cause of a blank or broken app), and the recent versions. Use it to spot broken asset paths and correlate errors with a version. Read-only. Returns { workspace, app, requests, count5xx, top404Paths:[{ path, count }], recentVersions:[{ number, compileStatus, actorKind, published, createdAt }] }.',
    fields: [
      { name: 'workspace', type: 'string', required: true, description: 'Workspace slug (from whoami).' },
      { name: 'slug', type: 'string', required: true, description: 'App slug.' },
      { name: 'since', type: 'string (ISO datetime, optional)', required: false, description: 'Aggregate signals at/after this time; defaults to the last 14 days.' },
    ],
    example: { workspace: 'acme', slug: 'my-todo' },
  },
];

/** The set of documented tool names (drift-guarded against the MCP registrations). */
export const TOOL_NAMES: string[] = TOOL_DOCS.map((t) => t.name);
