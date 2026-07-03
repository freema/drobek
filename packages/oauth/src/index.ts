/**
 * @drobek/oauth — the U5 MCP OAuth 2.1 Authorization Server (web app) + the
 * Resource Server helpers (mcp-server), as a workspace LIBRARY (PHY-71/PHY-53,
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
} from './constants.js';
export {
  SCOPES,
  DEFAULT_SCOPES,
  isKnownScope,
  parseScopes,
  serializeScopes,
  hasScope,
  type Scope,
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
} from './redirect-uri.js';
export {
  authorizationServerIssuer,
  buildAuthorizationServerMetadata,
} from './metadata.js';
export {
  createClient,
  findClientByClientId,
  type OAuthClient,
  type CreateClientInput,
} from './clients.server.js';
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
  type AccessTokenClaims,
  type ValidateOptions,
} from './tokens.server.js';
export {
  createMemoryOAuthStore,
  createDbOAuthStore,
  defaultOAuthStore,
  type OAuthStore,
  type OAuthRole,
  type AuthCodeRow,
  type AccessTokenRow,
  type RefreshTokenRow,
  type GrantRecord,
  type GrantKey,
} from './store.server.js';
