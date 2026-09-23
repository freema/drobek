/**
 * @drobek/oauth — the MCP OAuth 2.1 Authorization Server (U5; user-bound
 * grants, CIMD, RFC 9207 `iss` and API keys since M0-04) + the Resource
 * Server helpers, as a workspace LIBRARY (PHY-71/PHY-53,
 * same integration model as @drobek/auth): the heavy server logic lives here;
 * apps/web registers thin route files re-exporting `@drobek/oauth/routes/*`.
 *
 * This barrel exports ONLY pure/Node server logic — NO react-router route
 * modules — so the Express mcp-server can import it without pulling the web
 * framework into its runtime.
 */
export {
  AUTH_CODE_TTL_MS,
  ACCESS_TTL_MS,
  ACCESS_TTL_SEC,
  REFRESH_TTL_MS,
  CIMD_MAX_BYTES,
  CIMD_TIMEOUT_MS,
  DCR_RATE_LIMIT,
  DCR_MAX_UNUSED_CLIENTS,
} from './constants.js';
export {
  SCOPES,
  DEFAULT_SCOPES,
  TOOL_SCOPES,
  isKnownScope,
  knownScopes,
  parseScopes,
  serializeScopes,
  hasScope,
  toolAllowed,
  allowedTools,
  type Scope,
  type ToolName,
} from './scopes.js';
export {
  hashToken,
  generateOpaqueToken,
  generateClientId,
  verifyPkceS256,
} from './crypto.server.js';
export {
  exactRedirectUriMatch,
  isValidRegisterRedirectUri,
  isValidResource,
  checkClientMetadata,
  type ClientMetadataCheck,
} from './redirect-uri.js';
export {
  authorizationServerIssuer,
  authorizationServer,
  mcpResourceUri,
  isMcpResource,
  buildAuthorizationServerMetadata,
} from './metadata.js';
export {
  createClient,
  findClientByClientId,
  upsertCimdClient,
  markClientUsed,
  countUnusedDcrClients,
  pruneUnusedDcrClients,
  type OAuthClient,
  type ClientSource,
  type CreateClientInput,
} from './clients.server.js';
export {
  isUrlClientId,
  cimdDevOrigins,
  checkCimdClientIdUrl,
  validateCimdDocument,
  fetchCimdDocument,
  resolveCimdMetadata,
  CimdFetchError,
  type CimdClientMetadata,
  type CimdResolution,
  type CimdFetcher,
  type CimdCache,
  type CimdDeps,
} from './cimd.server.js';
export { resolveClient, type ClientResolution } from './client-resolve.server.js';
export {
  API_KEY_PREFIX,
  generateApiKey,
  isApiKeyFormat,
  looksLikeApiKey,
  createApiKey,
  validateApiKey,
  revokeApiKey,
  type CreatedApiKey,
  type ApiKeyClaims,
} from './api-keys.server.js';
export {
  issueAuthCode,
  consumeAuthCode,
  type IssueAuthCodeInput,
  type ConsumeAuthCodeInput,
  type ConsumeAuthCodeResult,
} from './codes.server.js';
export {
  issueAccessAndRefresh,
  rotateRefreshToken,
  revokeLineage,
  validateAccessToken,
  type GrantInput,
  type IssuedTokens,
  type RotateResult,
  type RotateOptions,
  type AccessTokenClaims,
  type ValidateOptions,
} from './tokens.server.js';
export {
  createMemoryOAuthStore,
  createDbOAuthStore,
  defaultOAuthStore,
  type OAuthStore,
  type AuthCodeRow,
  type AccessTokenRow,
  type RefreshTokenRow,
  type GrantRecord,
  type GrantKey,
} from './store.server.js';
