/**
 * MCP docs resources + guided prompts (M1b Agent DX, PHY-124).
 *
 * A connected agent can read the same delivery-stack contract that /llms.txt and
 * /llms-full.txt serve WITHOUT web access, and can pull up a guided prompt that
 * walks the exact add-data call sequence. All of this renders from the
 * @drobek/agent-dx manifest, so it stays in sync with the real tools.
 *
 * Discovery (resources/list, resources/read, prompts/list, prompts/get) is
 * scope-agnostic — registered on every session regardless of the granted token
 * scope. The docs contain no secrets; acting on them still requires the tool
 * scopes, which are gated in mcp.ts.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DOCS_RESOURCE_LLMS_FULL,
  DOCS_RESOURCE_TOOLS,
  renderLlmsFull,
  renderToolReference,
} from '@drobek/agent-dx';

/** Register the drobek docs resources + guided prompts on an MCP server. */
export function registerDocs(server: McpServer): void {
  server.registerResource(
    'drobek-llms-full',
    DOCS_RESOURCE_LLMS_FULL,
    {
      title: 'drobek — full delivery-stack contract',
      description:
        'Every MCP tool with its input schema + an example, data access modes, quotas/limits, and the error catalogue.',
      mimeType: 'text/plain',
    },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'text/plain', text: renderLlmsFull() },
      ],
    })
  );

  server.registerResource(
    'drobek-tools',
    DOCS_RESOURCE_TOOLS,
    {
      title: 'drobek — MCP tool reference',
      description:
        'The drobek MCP tools: name, scope, description, input fields, and one example call each.',
      mimeType: 'text/plain',
    },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'text/plain', text: renderToolReference() },
      ],
    })
  );

  server.registerPrompt(
    'add-data-to-app',
    {
      title: 'Add a data collection to a drobek app',
      description:
        'Guided: collection_define (schema first) → record_create → record_query.',
      argsSchema: {
        workspace: z.string().optional(),
        slug: z.string().optional(),
        collection: z.string().optional(),
      },
    },
    ({ workspace, slug, collection }) => {
      const ws = workspace ?? '<workspace slug from whoami>';
      const app = slug ?? '<app slug>';
      const coll = collection ?? '<collection name>';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Add a "${coll}" data collection to the drobek app ${ws}/${app}. Schema first:`,
                '',
                '1. If you do not know the workspace, call whoami — it lists every workspace you belong to (slug + role) — or list_apps to find the app.',
                `2. Define the collection FIRST: collection_define({ workspace: "${ws}", slug: "${app}", name: "${coll}", jsonSchema: { …JSON Schema… }, accessMode: "public-write" | "public-read" | "locked" }). Choose the access mode by who writes from the browser.`,
                `3. Seed/verify with record_create({ locator: { workspace: "${ws}", slug: "${app}" }, collection: "${coll}", doc: { … } }).`,
                `4. Read back with record_query({ locator: { workspace: "${ws}", slug: "${app}" }, collection: "${coll}" }).`,
                '',
                'Every write is validated against the schema. The authoritative shapes + access modes are in the drobek://docs/llms-full resource.',
              ].join('\n'),
            },
          },
        ],
      };
    }
  );
}
