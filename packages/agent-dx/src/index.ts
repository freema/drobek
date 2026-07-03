/**
 * @drobek/agent-dx — the M1b Agent DX pack (PHY-124): the SINGLE SOURCE OF TRUTH
 * for the agent-facing docs. A zero-dependency, react-free leaf package holding
 * the TOOL_DOCS manifest, the error catalogue + limits, and PURE renderers for
 * /llms.txt, /llms-full.txt, the MCP docs resources, and the build-with-your-agent
 * page. Consumed by apps/web (the llms routes + page) and @drobek/oauth/resource
 * (the MCP docs resources + guided prompts).
 *
 * Drift is enforced by a unit test in @drobek/oauth that asserts the registered
 * MCP tool names EQUAL `TOOL_NAMES`, so a tool can never ship without a doc.
 */
export {
  TOOL_DOCS,
  TOOL_NAMES,
  type ToolDoc,
  type ToolField,
} from './tools.js';
export { ERROR_CATALOGUE, type ErrorDoc } from './errors-catalogue.js';
export { LIMITS, type LimitDoc } from './limits.js';
export { publicAppUrl, publicMcpUrl, mcpEndpoint } from './urls.js';
export {
  SKILL_INSTALL_COMMAND,
  DOCS_RESOURCE_LLMS_FULL,
  DOCS_RESOURCE_TOOLS,
  renderLlmsTxt,
  renderLlmsFull,
  renderToolReference,
} from './render.js';
