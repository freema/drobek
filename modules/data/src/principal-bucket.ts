/**
 * The caller's own write bucket (NSO-324), checked BEFORE the per-app one, so
 * one client cannot use up the whole write budget of an app for every other
 * user: a signed-in end user counts under their id, a visitor under their
 * client IP. A visitor without a resolvable IP gets no own bucket — never a
 * shared `unknown` one that would lock every visitor out together (NSO-309);
 * the per-app limit still holds for them.
 */
import type { Principal } from '@drobek/modules';

/** `u:<end-user id>`, `ip:<address>`, or null (a visitor with no known IP). */
export function principalBucketKey(principal: Principal, clientIp: string | null): string | null {
  if (principal.kind === 'user') return `u:${principal.id}`;
  const ip = clientIp?.trim();
  return ip ? `ip:${ip}` : null;
}
