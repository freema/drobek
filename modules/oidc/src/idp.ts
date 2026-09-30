/**
 * Talking to one OpenID Connect provider: the discovery document (cached
 * OIDC_DISCOVERY_CACHE_SEC), its keys (cached 1 h; an unknown `kid` refetches
 * them at most once a minute per issuer) and the ID token check. Caches live
 * in process memory — a provider gets no Redis, and both documents are
 * public and cheap to fetch again after a restart.
 */
import { constants, createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { hasControl } from './config.js';
import { OidcError } from './errors.js';
import type { IdpFetch, IdpRequest } from './http.js';

export const DEFAULT_DISCOVERY_CACHE_SEC = 3600;
const JWKS_CACHE_MS = 60 * 60 * 1000;
const JWKS_REFETCH_MS = 60 * 1000;
/** Allowed distance of the ID token's `iat` from the server clock. */
const IAT_SKEW_SEC = 5 * 60;
/** The only ID token algorithms: asymmetric, no `none`, no HS*. */
const ID_TOKEN_ALGS = ['RS256', 'ES256', 'PS256'] as const;
type Alg = (typeof ID_TOKEN_ALGS)[number];

const MAX_CACHED_ISSUERS = 256;
const MAX_TOKEN_CHARS = 16 * 1024;
const MAX_JWKS_KEYS = 100;

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
}

/** Which URLs may be reached how: https only, except the dev origins; private addresses only for the operator's issuer host and the dev origins. */
export interface Trust {
  devOrigins: ReadonlySet<string>;
  /** `host` (with port) of AUTH_OIDC_ISSUER when the app uses it, else null. */
  operatorHost: string | null;
}

export interface IdpDeps {
  fetch: IdpFetch;
  now: () => number;
  discoveryCacheSec: () => number;
}

type Jwk = JsonWebKey & { kid?: string; use?: string; alg?: string };

const discoveryFail = (reason: string) => new OidcError('oidc_discovery_failed', reason);
const tokenFail = (reason: string) => new OidcError('oidc_token_invalid', reason);

/** A URL the IdP named, checked against the trust rules; `what` names it in errors. */
function checkUrl(raw: unknown, trust: Trust, what: string, fail = discoveryFail): Omit<IdpRequest, 'method' | 'headers' | 'body'> {
  if (typeof raw !== 'string' || raw.length > 2048) throw fail(`${what} is missing`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail(`${what} is not a URL`);
  }
  if (url.username || url.password) throw fail(`${what} carries credentials`);
  const dev = trust.devOrigins.has(url.origin);
  if (url.protocol !== 'https:' && !(dev && url.protocol === 'http:')) throw fail(`${what} is not https`);
  const trusted = dev || (trust.operatorHost !== null && url.host === trust.operatorHost);
  return { url, allowPrivate: trusted, anyPort: trusted };
}

function stringList(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fetch `req` and parse a JSON object (status 200 only — a redirect is never followed). */
async function fetchJson(deps: IdpDeps, req: IdpRequest, what: string, fail: (reason: string) => OidcError): Promise<Record<string, unknown>> {
  let res;
  try {
    res = await deps.fetch(req);
  } catch (err) {
    const kind = err instanceof Error && /blocked|private|port/i.test(err.message) ? 'a blocked address' : 'unreachable';
    throw fail(`${what} is ${kind}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(res.body.toString('utf8'));
  } catch {
    body = null;
  }
  if (res.status !== 200) {
    const code = isObject(body) && typeof body.error === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(body.error) ? ` (error=${body.error})` : '';
    throw fail(`${what} answered HTTP ${res.status}${code}`);
  }
  if (!isObject(body)) throw fail(`${what} is not a JSON object`);
  return body;
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHED_ISSUERS) map.delete(map.keys().next().value!);
}

export class Idp {
  private readonly discoveries = new Map<string, { doc: Discovery; expires: number }>();
  private readonly jwks = new Map<string, { uri: string; keys: Jwk[]; fetchedAt: number }>();

  constructor(private readonly deps: IdpDeps) {}

  /** `<issuer>/.well-known/openid-configuration`, validated (cached per issuer). */
  async discover(issuer: string, trust: Trust): Promise<Discovery> {
    const now = this.deps.now();
    const where = checkUrl(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, trust, 'the discovery URL');
    const hit = this.discoveries.get(issuer);
    if (hit && hit.expires > now) {
      checkUrl(hit.doc.authorization_endpoint, trust, 'authorization_endpoint');
      return hit.doc;
    }
    const raw = await fetchJson(this.deps, { ...where, method: 'GET', headers: { accept: 'application/json' } }, 'the discovery document', discoveryFail);
    if (raw.issuer !== issuer) {
      throw discoveryFail(`the discovery document names issuer ${JSON.stringify(String(raw.issuer).slice(0, 200))}, not the configured one`);
    }
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) checkUrl(raw[key], trust, key);
    if (raw.userinfo_endpoint !== undefined) checkUrl(raw.userinfo_endpoint, trust, 'userinfo_endpoint');
    const pkce = stringList(raw.code_challenge_methods_supported);
    // Absent = not advertised (Microsoft Entra ID leaves it out yet takes S256); listed without S256 = refused.
    if (raw.code_challenge_methods_supported !== undefined && !pkce?.includes('S256')) {
      throw discoveryFail('the provider does not support PKCE S256');
    }
    const doc: Discovery = {
      issuer,
      authorization_endpoint: raw.authorization_endpoint as string,
      token_endpoint: raw.token_endpoint as string,
      jwks_uri: raw.jwks_uri as string,
      ...(typeof raw.userinfo_endpoint === 'string' ? { userinfo_endpoint: raw.userinfo_endpoint } : {}),
      ...(stringList(raw.token_endpoint_auth_methods_supported) ? { token_endpoint_auth_methods_supported: stringList(raw.token_endpoint_auth_methods_supported) } : {}),
      ...(stringList(raw.id_token_signing_alg_values_supported) ? { id_token_signing_alg_values_supported: stringList(raw.id_token_signing_alg_values_supported) } : {}),
      ...(pkce ? { code_challenge_methods_supported: pkce } : {}),
    };
    remember(this.discoveries, issuer, { doc, expires: now + Math.max(1, this.deps.discoveryCacheSec()) * 1000 });
    return doc;
  }

  /** POST a form to the token endpoint and return its JSON answer. */
  async token(doc: Discovery, trust: Trust, form: URLSearchParams, headers: Record<string, string>): Promise<Record<string, unknown>> {
    const where = checkUrl(doc.token_endpoint, trust, 'token_endpoint');
    return fetchJson(
      this.deps,
      {
        ...where,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
        body: form.toString(),
      },
      'the token endpoint',
      tokenFail
    );
  }

  /** GET the userinfo endpoint with the access token. */
  async userinfo(doc: Discovery, trust: Trust, accessToken: string): Promise<Record<string, unknown>> {
    const where = checkUrl(doc.userinfo_endpoint, trust, 'userinfo_endpoint', tokenFail);
    return fetchJson(this.deps, { ...where, method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } }, 'the userinfo endpoint', tokenFail);
  }

  /** The issuer's signing keys; `kid` not among them → one refetch, at most once per JWKS_REFETCH_MS. */
  private async keys(doc: Discovery, trust: Trust, kid: string | undefined): Promise<Jwk[]> {
    const now = this.deps.now();
    const hit = this.jwks.get(doc.issuer);
    const fresh = hit && hit.uri === doc.jwks_uri && now - hit.fetchedAt < JWKS_CACHE_MS;
    if (fresh && (kid === undefined || hit.keys.some((k) => k.kid === kid) || now - hit.fetchedAt < JWKS_REFETCH_MS)) return hit.keys;
    const where = checkUrl(doc.jwks_uri, trust, 'jwks_uri');
    const raw = await fetchJson(this.deps, { ...where, method: 'GET', headers: { accept: 'application/json' } }, 'the key set (jwks_uri)', discoveryFail);
    if (!Array.isArray(raw.keys)) throw discoveryFail('the key set has no keys');
    const keys = (raw.keys as unknown[]).filter(isObject).slice(0, MAX_JWKS_KEYS) as Jwk[];
    remember(this.jwks, doc.issuer, { uri: doc.jwks_uri, keys, fetchedAt: now });
    return keys;
  }

  /**
   * The verified claims of an ID token (OIDC Core §3.1.3.7): an allowed
   * asymmetric algorithm the provider advertises, a signature by one of its
   * keys, `iss`, `aud` (+ `azp` with several audiences), `exp`, `iat` and
   * `nonce`.
   */
  async verifyIdToken(token: unknown, doc: Discovery, trust: Trust, expect: { clientId: string; nonce: string }): Promise<Record<string, unknown>> {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) throw tokenFail('the token answer has no ID token');
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]*$/.test(p)) || !parts[0] || !parts[1]) throw tokenFail('the ID token is not a signed JWT');
    const header = decodePart(parts[0]);
    const claims = decodePart(parts[1]);
    if (!header || !claims) throw tokenFail('the ID token is not a signed JWT');

    const alg = header.alg;
    if (typeof alg !== 'string' || !(ID_TOKEN_ALGS as readonly string[]).includes(alg)) throw tokenFail(`the ID token algorithm ${JSON.stringify(String(alg)).slice(0, 20)} is not allowed`);
    const advertised = doc.id_token_signing_alg_values_supported ?? ['RS256'];
    if (!advertised.includes(alg)) throw tokenFail(`the provider does not advertise ${alg}`);
    if (header.crit !== undefined) throw tokenFail('the ID token has critical header parameters');
    const kid = typeof header.kid === 'string' ? header.kid : undefined;

    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    const signature = Buffer.from(parts[2], 'base64url');
    const candidates = (await this.keys(doc, trust, kid)).filter((k) => usableKey(k, alg as Alg, kid));
    if (candidates.length === 0) throw tokenFail(kid ? 'no key of the provider has the ID token kid' : 'no key of the provider fits the ID token');
    if (!candidates.some((k) => verifyWith(k, alg as Alg, signingInput, signature))) throw tokenFail('the ID token signature is invalid');

    const now = Math.floor(this.deps.now() / 1000);
    if (claims.iss !== doc.issuer) throw tokenFail('the ID token iss is not the issuer');
    const aud = typeof claims.aud === 'string' ? [claims.aud] : stringList(claims.aud);
    if (!aud || !aud.includes(expect.clientId)) throw tokenFail('the ID token aud does not name the client');
    if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== expect.clientId) throw tokenFail('the ID token azp is not the client');
    if (typeof claims.exp !== 'number' || claims.exp <= now) throw tokenFail('the ID token expired');
    if (typeof claims.iat !== 'number' || Math.abs(claims.iat - now) > IAT_SKEW_SEC) throw tokenFail('the ID token iat is off by more than 5 minutes');
    if (typeof claims.nonce !== 'string' || claims.nonce !== expect.nonce) throw tokenFail('the ID token nonce does not match');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || hasControl(claims.sub)) throw tokenFail('the ID token has no usable sub');
    return claims;
  }
}

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

const KTY: Record<Alg, string> = { RS256: 'RSA', PS256: 'RSA', ES256: 'EC' };

function usableKey(k: Jwk, alg: Alg, kid: string | undefined): boolean {
  if (kid !== undefined && k.kid !== kid) return false;
  if (k.kty !== KTY[alg]) return false;
  if (k.use !== undefined && k.use !== 'sig') return false;
  return k.alg === undefined || k.alg === alg;
}

function publicKey(jwk: Jwk): KeyObject | null {
  try {
    return createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return null;
  }
}

function verifyWith(jwk: Jwk, alg: Alg, data: Buffer, signature: Buffer): boolean {
  const key = publicKey(jwk);
  if (!key) return false;
  const details = key.asymmetricKeyDetails ?? {};
  try {
    if (alg === 'ES256') {
      if (key.asymmetricKeyType !== 'ec' || details.namedCurve !== 'prime256v1') return false;
      return verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    if (key.asymmetricKeyType !== 'rsa' || (details.modulusLength ?? 0) < 2048) return false;
    if (alg === 'PS256') {
      return verify('sha256', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature);
    }
    return verify('sha256', data, key, signature);
  } catch {
    return false;
  }
}
