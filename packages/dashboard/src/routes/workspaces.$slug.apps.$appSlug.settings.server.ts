/**
 * GET/POST /workspaces/:slug/apps/:appSlug/settings — server half of the
 * Settings tab (NSO-288).
 *
 * GET (viewer+): visibility (public / password — never the hash, only
 * whether one is set), the frame-ancestors override, when a delete would
 * release the slug. POST (editor+, `appAction`): `visibility` (+ a new
 * password, scrypt-hashed here with the app-host gate's own hasher),
 * `frame-ancestors` (validated with the header builder's own parser) and
 * `delete` (soft delete; the form must repeat the app's slug). Each is
 * audited by @drobek/apps and busts the app hosts' cache.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { SLUG_RELEASE_AFTER_MS } from '@drobek/apps';
import { APP_PASSWORD_MAX, APP_PASSWORD_MIN, appAction, appHeaderData, loadAppPage } from '../app-page.server.js';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const page = await loadAppPage(request, params, 'viewer');
  const { app } = page;
  return {
    header: await appHeaderData(page),
    settings: {
      visibility: app.visibility,
      hasPassword: app.hasPassword,
      frameAncestors: app.frameAncestors,
      slugReleaseDays: Math.round(SLUG_RELEASE_AFTER_MS / (24 * 60 * 60 * 1000)),
      passwordMin: APP_PASSWORD_MIN,
      passwordMax: APP_PASSWORD_MAX,
    },
  };
}

export const action = appAction;
