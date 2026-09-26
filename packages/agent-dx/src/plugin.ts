/**
 * The drobek agent plugin (M0-10, NSO-302) — `freema/drobek-plugin` (MIT) ships
 * the drobek MCP server, the `build-app-on-drobek` skill (Claude Code, Codex and
 * Cursor variants), a Cursor routing rule and the `/drobek:build-app` command;
 * NSO-359 adds `/drobek:port-artifact` (a Claude artifact → a drobek app; the
 * Codex variant is the `port-artifact-to-drobek` skill).
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
/** The plugin's port command (Claude Code): a Claude artifact → a drobek app (NSO-359). */
export const PLUGIN_PORT_COMMAND = `/${PLUGIN_NAME}:port-artifact`;

/**
 * The skills rule every drobek skill states VERBATIM (skills/drobek and the
 * plugin's three skill variants — guarded by skill.test.ts here and by
 * scripts/check-drobek.mjs in the plugin repo). It is true on every server,
 * with or without platform modules: `skill_info` always exists and lists what
 * this server has (possibly nothing), and create_app/get_app carry the list.
 */
export const SKILL_INFO_RULE =
  'Before using a backend (login, stored data, forms, email, file uploads, external APIs), call `skill_info` and follow the skill; `create_app`/`get_app` list the available skills.';
