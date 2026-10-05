/**
 * GET /whats-new — public, no login: 302 to the GitHub release of the running
 * version (`DROBEK_VERSION`), or to the releases list for a dev build.
 */
import { whatsNewRedirect } from '../whats-new.server.js';

export function loader(): Response {
  return whatsNewRedirect();
}
