/**
 * Per-client-IP rate-limit keys (NSO-309, NSO-328). One implementation for
 * every per-IP bucket in drobek: the dashboard sign-in guards, DCR, the app
 * password gate, the module router's `per: 'ip'`, the proxy's `public-ip`, the
 * error beacon and the abuse report form.
 *
 * A request whose client IP could not be resolved (no trusted proxy header —
 * the plain-HTTP dev stack, a request that bypassed the proxy, a misconfigured
 * `TRUST_PROXY`) gets NO per-IP bucket: the caller skips that check and keeps
 * its other protections (per app, per principal, per code). The former
 * `ip ?? 'unknown'` key put every such client into ONE shared bucket, so a
 * handful of requests locked everybody out. Skipping loses nothing a spoofer
 * could not already get by rotating forged headers.
 *
 * The first skip of each bucket logs one warning per process so a
 * misconfigured proxy is visible without flooding the log.
 */
import { createConsoleLogger, type Logger } from './logger.js';

const defaultLog: Logger = createConsoleLogger('rate-limit');
const warnedBuckets = new Set<string>();

/**
 * The key of the per-IP bucket `bucket` for this client: the resolved IP, or
 * `null` when there is none — the caller must then skip the per-IP check
 * (never substitute a shared placeholder). `bucket` only labels the warning.
 */
export function perIpLimitKey(ip: string | null | undefined, bucket: string, log: Logger = defaultLog): string | null {
  const key = ip?.trim();
  if (key) return key;
  if (!warnedBuckets.has(bucket)) {
    warnedBuckets.add(bucket);
    log.warn(
      `[rate-limit] no client IP resolved — per-IP limit "${bucket}" skipped (check TRUST_PROXY and the proxy X-Real-IP header)`,
      { event: 'rate_limit_no_client_ip', bucket }
    );
  }
  return null;
}
