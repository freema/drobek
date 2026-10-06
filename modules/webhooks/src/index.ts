/**
 * drobek-module-webhooks — the BUILT-IN platform module `webhooks`: an app
 * receives webhooks from other services (payments, code hosting, form
 * services — anything that signs with HMAC) without running any app code.
 *
 *   DROBEK_MODULES=…,data,webhooks  → this package (`modules/webhooks` in the
 *                                     drobek repo, a dependency of the server).
 *
 *   POST /__drobek/v1/webhooks/:endpoint   one delivery (routes.ts)
 *   config { endpoints: { <name>: { collection, verify, header?, id_header?, secret?, max_bytes?, enabled } } }
 *
 * Each endpoint verifies a delivery with its own module secret (secretsFor:
 * `WEBHOOK_SECRET_<NAME>` unless the config names another), entered in the
 * dashboard only, and stores it as a record of a collection declared in the
 * data config; the app reads it with `drobek.data`. No SDK. The `webhooks`
 * authority gives the owner the endpoints and the delivery log (the
 * dashboard module page, get_logs `webhooks`); the daily server job prunes
 * the log and the remembered event ids.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publishedUrl } from '@drobek/apps';
import type { DB } from '@drobek/db';
import { defineModule, type HookApp, type ModuleErrorDoc, type WebhookEndpointState, type WebhooksAuthority } from '@drobek/modules';
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_ENDPOINTS_PER_APP,
  DEFAULT_PER_APP_PER_MINUTE,
  WEBHOOKS_CONFIG_DEFAULTS,
  secretOf,
  webhooksConfigSchema,
  webhooksConfirmRequiredIn,
  webhooksSecrets,
  type WebhooksConfig,
} from './config.js';
import { registerRoutes } from './routes.js';
import { lastDeliveries, pruneDeliveries, recentDeliveries } from './store.js';

export {
  BODY_CEILING_BYTES,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_ENDPOINTS_PER_APP,
  DEFAULT_PER_APP_PER_MINUTE,
  ENDPOINT_NAME_RE,
  VERIFY_SCHEMES,
  WEBHOOKS_CONFIG_DEFAULTS,
  secretOf,
  webhooksConfigSchema,
  webhooksConfirmRequired,
  webhooksConfirmRequiredIn,
  webhooksLimits,
  webhooksSecrets,
  type VerifyScheme,
  type WebhookEndpoint,
  type WebhooksConfig,
} from './config.js';
export { DELIVERIES_KEPT_DAYS, DELIVERIES_KEPT_PER_APP, EVENT_ID_TTL_MS, claimEvent, pruneDeliveries, recentDeliveries } from './store.js';
export { webhookDeliveries, webhookEvents } from './schema.js';
export { TIMESTAMP_TOLERANCE_SEC, eventFacts, payloadOf, signatureBytes, verifyDelivery } from './verify.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The address a sender posts to: the app's production host (module routes answer on every app host). */
export function endpointUrl(slug: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${publishedUrl(slug, env)}/__drobek/v1/webhooks/${name}`;
}

const WEBHOOKS_ERRORS: ModuleErrorDoc[] = [
  {
    code: 'invalid_signature',
    meaning: 'HTTP 401 to the SENDER. The delivery has no valid signature or token for the endpoint\'s secret (`details.reason`: missing_signature | bad_signature | timestamp_out_of_tolerance). Nothing was stored; get_logs(kind: "webhooks") lists it as rejected_signature.',
    fix: 'Check the endpoint\'s `verify` matches how the service signs, that the owner copied the service\'s signing secret into the endpoint\'s secret in the dashboard, and (stripe) that the server clock is right. A tampered or replayed delivery is meant to fail.',
  },
  {
    code: 'webhook_secret_not_set',
    meaning: 'HTTP 503 to the SENDER. The endpoint\'s secret (`details.secret`) is not set, so nothing can be verified; the sender retries.',
    fix: 'Ask the owner to set the secret on the webhooks module page in the dashboard (get_app → modules.webhooks.secrets shows hasSecret). Never ask for its value in chat.',
  },
  {
    code: 'webhook_not_stored',
    meaning: 'HTTP 503 to the SENDER. The delivery was verified but the collection refused it (`details.reason`: not_found — the collection is not declared, validation_failed — its schema rejects the record, quota_exceeded, unavailable — no data module). The sender retries.',
    fix: 'Declare the collection with configure_module(\'data\') without a schema that rejects { source, event_type, event_id, received_at, payload }, or free quota; the retry is then stored.',
  },
];

/** The endpoints of one app with their last delivery (the owner's view and get_app's info). */
async function endpointStates(db: DB, app: HookApp, config: WebhooksConfig): Promise<WebhookEndpointState[]> {
  const last = await lastDeliveries(db, app.id);
  return Object.keys(config.endpoints)
    .sort()
    .map((name) => {
      const e = config.endpoints[name];
      const l = last.get(name);
      return {
        name,
        url: endpointUrl(app.slug, name),
        collection: e.collection,
        verify: e.verify,
        signed: e.verify !== 'none-with-token',
        secret: secretOf(name, e),
        enabled: e.enabled,
        last_delivery_at: l?.received_at ?? null,
        last_status: l?.status ?? null,
      };
    });
}

const authority: WebhooksAuthority<WebhooksConfig> = {
  endpoints: (view) => endpointStates(view.db, view.app, view.config),
  deliveries: (view, q) => recentDeliveries(view.db, view.app.id, q),
};

const webhooks = defineModule<WebhooksConfig>({
  name: 'webhooks',
  version: '1.0.0',
  contract: '^1.3',
  requires: ['data'],
  errors: WEBHOOKS_ERRORS,
  skill: {
    useWhen:
      'another service (payments, code hosting, a form service) must notify the app with signed webhooks: drobek verifies each POST and stores it in a data collection the app reads',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  dashboard: {
    title: 'Incoming webhooks',
    description: 'Gives the app an address other services post events to: each one is checked against its secret and stored in a data collection.',
  },
  configSchema: webhooksConfigSchema,
  configDefaults: WEBHOOKS_CONFIG_DEFAULTS,
  confirmRequired: webhooksConfirmRequiredIn,
  secretsFor: (config) => webhooksSecrets(config),
  limits: [
    { env: 'WEBHOOKS_MAX_BODY_BYTES', default: DEFAULT_MAX_BODY_BYTES, meaning: 'bytes of one webhook delivery (at most 1 MiB, whatever the value)' },
    { env: 'WEBHOOKS_PER_APP_PER_MINUTE', default: DEFAULT_PER_APP_PER_MINUTE, meaning: 'webhook deliveries one app takes per minute (all its endpoints)' },
    { env: 'WEBHOOKS_MAX_ENDPOINTS_PER_APP', default: DEFAULT_MAX_ENDPOINTS_PER_APP, meaning: 'webhook endpoints one app may have' },
  ],
  routes: registerRoutes,
  webhooks: authority,
  appInfo: async (view) => ({ endpoints: await endpointStates(view.db, view.app, view.config) }),
  jobs: [
    {
      name: 'prune',
      scope: 'server',
      description: 'removes webhook deliveries older than 30 days (and past 1000 per app) and expired event ids',
      every: '1d',
      run: async (ctx) => {
        const out = await pruneDeliveries(ctx.db);
        if (out.deliveries > 0 || out.events > 0) ctx.log.info('webhooks: pruned', { deliveries: out.deliveries, events: out.events });
      },
    },
  ],
  migrations: { folder: here('../migrations') },
});

export default webhooks;
