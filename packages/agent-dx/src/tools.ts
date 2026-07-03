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
    name: 'deploy_init',
    title: 'Begin a deploy',
    scope: 'deploy:write (editor+ role)',
    description:
      'Begin a deploy: validate the file manifest (an index.html at the root is REQUIRED), create or target the app (slug derived from name, overridable), and return presigned PUT URLs for ONLY the files whose content is not already stored (content-hash dedup). Returns { deployId, app:{workspace,slug,url}, uploads:[{path,putUrl}] }.',
    fields: [
      { name: 'name', type: 'string (optional)', required: false, description: 'App display name; the slug is derived from it on first deploy.' },
      { name: 'slug', type: 'string (optional)', required: false, description: 'Explicit app slug (target an existing app, or pin the slug).' },
      { name: 'manifest', type: '{ path, sha256, bytes }[]', required: true, description: 'Every file in the deploy: repo-relative path, sha256 hex of the bytes, and byte length. Must include index.html at the root.' },
    ],
    example: {
      name: 'my-todo',
      manifest: [
        { path: 'index.html', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', bytes: 512 },
        { path: 'app.js', sha256: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae', bytes: 1024 },
      ],
    },
  },
  {
    name: 'deploy_commit',
    title: 'Finalize a deploy',
    scope: 'deploy:write (editor+ role)',
    description:
      'Finalize a deploy after its files are uploaded: verify every manifest blob is stored, enqueue the build/lint/activate job, and return the queued state. Poll deploy_status for progress.',
    fields: [
      { name: 'deployId', type: 'string', required: true, description: 'The deployId returned by deploy_init.' },
    ],
    example: { deployId: 'dpl_01hzz…' },
  },
  {
    name: 'deploy_status',
    title: 'Poll a deploy',
    scope: 'apps:read',
    description:
      'Report a deploy pipeline state (awaiting_upload → queued → linting → storing → activating → ready | failed), whether it is the app’s active version, its live URL, and any lint report/error. Poll until state === "ready", then open the URL.',
    fields: [
      { name: 'deployId', type: 'string', required: true, description: 'The deployId to inspect.' },
    ],
    example: { deployId: 'dpl_01hzz…' },
  },
  {
    name: 'rollback',
    title: 'Roll back an app',
    scope: 'deploy:write (editor+ role)',
    description:
      'Roll an app back to a prior ready deploy by repointing its active version (defaults to the previous good deploy; pass toDeployId to target a specific one).',
    fields: [
      { name: 'slug', type: 'string', required: true, description: 'The app slug to roll back.' },
      { name: 'toDeployId', type: 'string (optional)', required: false, description: 'Target a specific prior ready deploy; omit for the previous good one.' },
    ],
    example: { slug: 'my-todo' },
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
      { name: 'name', type: 'string', required: true, description: 'Collection name (URL segment in the REST API).' },
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
];

/** The set of documented tool names (drift-guarded against the MCP registrations). */
export const TOOL_NAMES: string[] = TOOL_DOCS.map((t) => t.name);
