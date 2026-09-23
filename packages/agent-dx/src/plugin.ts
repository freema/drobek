/**
 * The drobek agent plugin (M0-10, NSO-302) — `freema/drobek-plugin` (MIT) ships
 * the drobek MCP server, the `build-app-on-drobek` skill (Claude Code, Codex and
 * Cursor variants), a Cursor routing rule and the `/drobek:build-app` command.
 * The install lines rendered on /llms.txt, /llms-full.txt and
 * /build-with-your-agent come from HERE, so every surface names the same
 * marketplace and plugin.
 */

/** GitHub `owner/repo` of the plugin marketplace. */
export const PLUGIN_REPO = 'freema/drobek-plugin';
export const PLUGIN_REPO_URL = `https://github.com/${PLUGIN_REPO}`;
/** The marketplace name in the plugin repo's `.claude-plugin/marketplace.json`. */
export const PLUGIN_MARKETPLACE = 'drobek';
/** The plugin name (its commands are namespaced `/drobek:…`). */
export const PLUGIN_NAME = 'drobek';
/** The MCP endpoint the plugin's `.mcp.json` connects — the hosted drobek. */
export const PLUGIN_MCP_URL = 'https://drobek.app/mcp';

/** Claude Code: add the marketplace, then install the plugin from it. */
export const PLUGIN_MARKETPLACE_ADD_COMMAND = `claude plugin marketplace add ${PLUGIN_REPO}`;
export const PLUGIN_INSTALL_COMMAND = `claude plugin install ${PLUGIN_NAME}@${PLUGIN_MARKETPLACE}`;
/** The plugin's build command (Claude Code). */
export const PLUGIN_BUILD_COMMAND = `/${PLUGIN_NAME}:build-app`;

/**
 * The platform-module rule every drobek skill states VERBATIM (skills/drobek
 * and the plugin's three skill variants — guarded by skill.test.ts here and by
 * scripts/check-drobek.mjs in the plugin repo). A skill is installed once and
 * outlives server releases, so it states the rule conditionally; the briefing
 * a server returns lists exactly the modules that server has.
 */
export const MODULE_INFO_RULE =
  'drobek has no platform modules in this workspace yet; build self-contained front-ends. If your tool list includes `module_info`, call it for a module before using that module.';
