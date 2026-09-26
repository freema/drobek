/**
 * @drobek/agent-dx — the SINGLE SOURCE OF TRUTH for the agent-facing docs: a
 * zero-dependency, react-free leaf package holding the TOOL_DOCS manifest (the
 * MCP tools register with its titles, descriptions and annotations), the app
 * briefing, the error catalogue + limits, and PURE renderers for /llms.txt,
 * /llms-full.txt, the MCP docs resources and the build-with-your-agent page.
 *
 * Drift is enforced by a unit test in @drobek/oauth that asserts the registered
 * MCP tools EQUAL `TOOL_DOCS` (names, input fields, annotations, scopes).
 */
export {
  TOOL_DOCS,
  TOOL_NAMES,
  toolDoc,
  type ToolAnnotations,
  type ToolDoc,
  type ToolField,
} from './tools.js';
export { ERROR_CATALOGUE, errorDoc, errorHint, type ErrorDoc } from './errors-catalogue.js';
export {
  APP_LOCK_TTL_SEC,
  LIMITS,
  REASONING_MAX_CHARS,
  WRITE_FILES_MAX,
  type LimitDoc,
} from './limits.js';
export {
  REACT_VERSION,
  TAILWIND_BROWSER_URL,
  TEMPLATE_IMPORTS,
  renderBriefing,
  type BriefingLimits,
} from './briefing.js';
export {
  publicAppUrl,
  mcpEndpoint,
  protectedResourceMetadataUrl,
} from './urls.js';
export {
  SKILL_INFO_RULE,
  PLUGIN_BUILD_COMMAND,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_MARKETPLACE,
  PLUGIN_MARKETPLACE_ADD_COMMAND,
  PLUGIN_MCP_URL,
  PLUGIN_NAME,
  PLUGIN_REPO,
  PLUGIN_REPO_URL,
} from './plugin.js';
export {
  AGENT_GUIDE_URL,
  SKILL_INSTALL_COMMAND,
  DOCS_RESOURCE_LLMS_FULL,
  DOCS_RESOURCE_TOOLS,
  renderLlmsTxt,
  renderLlmsFull,
  renderToolReference,
  type ModuleErrorsDoc,
} from './render.js';
