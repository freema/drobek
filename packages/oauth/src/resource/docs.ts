/**
 * MCP docs resources + guided prompts (M1b Agent DX, PHY-124).
 *
 * A connected agent can read the same delivery-stack contract that /llms.txt and
 * /llms-full.txt serve WITHOUT web access, and can pull up a guided prompt that
 * walks the exact deploy / add-data call sequence. All of this renders from the
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
        'Every MCP tool with its input schema + an example, the REST Data API, the deploy flow, the serving model, quotas/limits, and the error catalogue.',
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
    'deploy-this-project',
    {
      title: 'Deploy this project to drobek',
      description:
        'Guided: structure the app → deploy_init → PUT files → deploy_commit → poll deploy_status → open the live URL.',
      argsSchema: {
        name: z.string().optional(),
        dir: z.string().optional(),
      },
    },
    ({ name, dir }) => {
      const app = name ? `"${name}"` : 'this project';
      const from = dir ? ` in \`${dir}\`` : '';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Deploy ${app}${from} to drobek. Follow this exact sequence:`,
                '',
                '1. Make sure the deploy has an `index.html` at the ROOT and uses relative asset paths (it is served under /:ws/app/:slug/). Ship static files only — the deploy lint blocks non-static bundles.',
                '2. Build the manifest: for every file, compute { path, sha256 (hex), bytes }.',
                '3. Call deploy_init({ name, manifest }). It returns a deployId, the app { workspace, slug, url }, and presigned PUT URLs for the files not already stored.',
                '4. PUT each returned putUrl with the exact file bytes.',
                '5. Call deploy_commit({ deployId }).',
                '6. Poll deploy_status({ deployId }) until state === "ready" (awaiting_upload → queued → linting → storing → activating → ready | failed).',
                '7. On ready, open the returned live URL and verify it. On failed, read the lint report and fix the flagged code, then redeploy.',
                '',
                'The authoritative tool schemas are in the drobek://docs/llms-full resource.',
              ].join('\n'),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    'add-data-to-app',
    {
      title: 'Add a data collection to a drobek app',
      description:
        'Guided: collection_define (schema first) → record_create → record_query, wired to the same-origin REST API.',
      argsSchema: {
        workspace: z.string().optional(),
        slug: z.string().optional(),
        collection: z.string().optional(),
      },
    },
    ({ workspace, slug, collection }) => {
      const ws = workspace ?? '<workspace from whoami>';
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
                '1. If you do not know the workspace, call whoami to get its slug.',
                `2. Define the collection FIRST: collection_define({ workspace: "${ws}", slug: "${app}", name: "${coll}", jsonSchema: { …JSON Schema… }, accessMode: "public-write" | "public-read" | "locked" }). Choose the access mode by who writes from the browser.`,
                `3. Seed/verify with record_create({ locator: { workspace: "${ws}", slug: "${app}" }, collection: "${coll}", doc: { … } }).`,
                `4. Read back with record_query({ locator: { workspace: "${ws}", slug: "${app}" }, collection: "${coll}" }).`,
                '5. In the deployed browser app, hit the same data over same-origin REST: GET/POST /:ws/app/:slug/data/:collection and GET/PATCH/DELETE /:ws/app/:slug/data/:collection/:id.',
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
