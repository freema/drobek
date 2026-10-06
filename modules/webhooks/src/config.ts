/**
 * The webhooks module's per-app config:
 *
 *   { endpoints: { <name>: { collection, verify, header?, id_header?,
 *                            secret?, max_bytes?, enabled } } }
 *
 * An endpoint takes `POST /__drobek/v1/webhooks/<name>` on the app's hosts,
 * verifies it with the app's module secret `secret` (default
 * `WEBHOOK_SECRET_<NAME>`, entered in the dashboard only) by the scheme
 * `verify`, and stores the payload as a record of the data collection
 * `collection`.
 *
 * Changes that wait for the owner's confirmation (an editor may confirm): a
 * new endpoint, a changed collection, and a verification switched to the
 * weaker `none-with-token`. Everything else — `header`, `id_header`,
 * `secret`, `max_bytes`, `enabled`, removing an endpoint — applies at once.
 * An endpoint past WEBHOOKS_MAX_ENDPOINTS_PER_APP is refused.
 */
import { ModuleError, z, type ConfigFieldMeta, type ConfirmContext, type ConfirmItem, type Limits, type ModuleSecretDoc } from '@drobek/modules';

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
/** The most bytes any delivery may have, whatever WEBHOOKS_MAX_BODY_BYTES says. */
export const BODY_CEILING_BYTES = 1024 * 1024;
export const DEFAULT_PER_APP_PER_MINUTE = 120;
export const DEFAULT_MAX_ENDPOINTS_PER_APP = 10;
/** The schema's own cap on endpoints (the operator's WEBHOOKS_MAX_ENDPOINTS_PER_APP is checked on configure). */
const MAX_ENDPOINTS = 50;

export const ENDPOINT_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const COLLECTION_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HEADER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const SECRET_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** The verification schemes, strongest first: the signed ones, then a shared token. */
export const VERIFY_SCHEMES = ['hmac-sha256', 'stripe', 'github', 'none-with-token'] as const;
export type VerifyScheme = (typeof VERIFY_SCHEMES)[number];

/** The signed schemes: an HMAC of the body (and, for `stripe`, a timestamp). */
const SIGNED: ReadonlySet<VerifyScheme> = new Set(['hmac-sha256', 'stripe', 'github']);

const endpointSchema = z.strictObject({
  collection: z.string().regex(COLLECTION_RE, 'a collection declared in the data config').meta({
    title: 'Collection',
    description: 'The data collection every accepted delivery is stored in; the app reads it with drobek.data.',
    'x-drobek-choices': 'collections',
  } satisfies ConfigFieldMeta),
  verify: z.enum(VERIFY_SCHEMES).default('hmac-sha256').meta({
    title: 'Verification',
    description:
      'hmac-sha256: an HMAC-SHA256 of the body in a header; stripe: the Stripe-Signature header (with a timestamp); github: X-Hub-Signature-256; none-with-token: the secret itself sent as a token (weaker: anyone who sees the URL and token can post).',
  }),
  header: z
    .string()
    .regex(HEADER_RE, 'a header name (letters, digits and -)')
    .optional()
    .meta({
      title: 'Signature or token header',
      description: 'hmac-sha256: the header with the signature (default X-Webhook-Signature); none-with-token: the header with the token (default X-Webhook-Token, or ?token= in the URL). Not used by stripe and github.',
    }),
  id_header: z
    .string()
    .regex(HEADER_RE, 'a header name (letters, digits and -)')
    .optional()
    .meta({
      title: 'Event id header',
      description: 'The header with the sender’s event id, used to store a retried delivery once (default Webhook-Id). stripe and github have their own.',
    }),
  secret: z
    .string()
    .regex(SECRET_RE, 'an UPPER_SNAKE secret name')
    .optional()
    .meta({
      title: 'Secret name',
      description: 'The secret the endpoint verifies with (default WEBHOOK_SECRET_<NAME>). Its value is entered under Secrets on this page, never in chat.',
    }),
  max_bytes: z
    .number()
    .int()
    .min(1)
    .max(BODY_CEILING_BYTES)
    .optional()
    .meta({
      title: 'Largest delivery',
      description: 'A delivery with a larger body is refused (413). Empty: the server’s WEBHOOKS_MAX_BODY_BYTES.',
      'x-drobek-unit': 'bytes',
      'x-drobek-default-limit': 'WEBHOOKS_MAX_BODY_BYTES',
    } satisfies ConfigFieldMeta),
  enabled: z.boolean().default(true).meta({ title: 'Enabled', description: 'Off: the endpoint answers 404 and stores nothing.' }),
});

export type WebhookEndpoint = z.infer<typeof endpointSchema>;

export const webhooksConfigSchema = z.strictObject({
  endpoints: z
    .record(
      z
        .string()
        .regex(ENDPOINT_NAME_RE, 'an endpoint name: lowercase letters, digits, - and _, a letter first (max 40)')
        .meta({ title: 'Endpoint name', description: 'Part of the URL: /__drobek/v1/webhooks/<name>, e.g. payments.' }),
      endpointSchema
    )
    .refine((e) => Object.keys(e).length <= MAX_ENDPOINTS, `at most ${MAX_ENDPOINTS} endpoints`)
    .default({})
    .meta({
      title: 'Endpoints',
      description: 'Each endpoint receives POSTs from one service, verifies them with its secret and stores each one as a record of its collection. A new endpoint, another collection or a switch to none-with-token waits for confirmation.',
    }),
});

export type WebhooksConfig = z.infer<typeof webhooksConfigSchema>;

export const WEBHOOKS_CONFIG_DEFAULTS: WebhooksConfig = { endpoints: {} };

/** The secret an endpoint verifies with: its `secret`, or WEBHOOK_SECRET_<NAME>. */
export function secretOf(name: string, endpoint: Pick<WebhookEndpoint, 'secret'>): string {
  return endpoint.secret ?? `WEBHOOK_SECRET_${name.toUpperCase().replace(/-/g, '_')}`;
}

/** An endpoint of the config by name (own keys only), or null. */
export function endpointOf(config: WebhooksConfig, name: string): WebhookEndpoint | null {
  return Object.prototype.hasOwnProperty.call(config.endpoints, name) ? config.endpoints[name] : null;
}

/** The secrets the config's endpoints verify with (secretsFor): one per name, required. */
export function webhooksSecrets(config: WebhooksConfig): ModuleSecretDoc[] {
  const byName = new Map<string, string[]>();
  for (const name of Object.keys(config.endpoints ?? {}).sort()) {
    const s = secretOf(name, config.endpoints[name]);
    byName.set(s, [...(byName.get(s) ?? []), name]);
  }
  return [...byName].map(([name, endpoints]) => ({
    name,
    description: `The signing secret (or token) of the webhook endpoint${endpoints.length > 1 ? 's' : ''} ${endpoints.map((e) => `"${e}"`).join(', ')}: copy it from the sending service.`,
    required: true,
  }));
}

function positive(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
}

export interface WebhooksLimits {
  maxBodyBytes: number;
  perAppPerMinute: number;
  maxEndpoints: number;
}

/** The module's limits of one workspace (missing/invalid → the defaults; the body cap never above BODY_CEILING_BYTES). */
export function webhooksLimits(limits: Limits): WebhooksLimits {
  return {
    maxBodyBytes: Math.min(positive(limits.WEBHOOKS_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES), BODY_CEILING_BYTES),
    perAppPerMinute: positive(limits.WEBHOOKS_PER_APP_PER_MINUTE, DEFAULT_PER_APP_PER_MINUTE),
    maxEndpoints: positive(limits.WEBHOOKS_MAX_ENDPOINTS_PER_APP, DEFAULT_MAX_ENDPOINTS_PER_APP),
  };
}

function describeVerify(v: VerifyScheme): string {
  return v === 'none-with-token' ? 'a shared token (no signature)' : `a ${v} signature`;
}

/** The changes that wait for the owner (see the file header); pure. */
export function webhooksConfirmRequired(before: WebhooksConfig, after: WebhooksConfig): ConfirmItem[] {
  const out: ConfirmItem[] = [];
  for (const name of Object.keys(after.endpoints).sort()) {
    const a = after.endpoints[name];
    const b = endpointOf(before, name);
    if (!b) {
      out.push(`webhooks.endpoints.${name}: new endpoint — POST /__drobek/v1/webhooks/${name}, verified by ${describeVerify(a.verify)} with ${secretOf(name, a)}, stores every delivery in the collection "${a.collection}"`);
      continue;
    }
    if (a.collection !== b.collection) {
      out.push(`webhooks.endpoints.${name}: collection changed — deliveries now go to "${a.collection}" (was "${b.collection}")`);
    }
    if (a.verify === 'none-with-token' && SIGNED.has(b.verify)) {
      out.push(`webhooks.endpoints.${name}: verification weakened — ${b.verify} → none-with-token (${describeVerify(a.verify)})`);
    }
  }
  return out;
}

/**
 * configure_module's hook: refuse endpoints past WEBHOOKS_MAX_ENDPOINTS_PER_APP
 * (only when the change adds one), then {@link webhooksConfirmRequired}.
 */
export async function webhooksConfirmRequiredIn(before: WebhooksConfig, after: WebhooksConfig, context: ConfirmContext): Promise<ConfirmItem[]> {
  const limits = webhooksLimits(context.limits ? await context.limits() : {});
  const count = Object.keys(after.endpoints).length;
  if (count > limits.maxEndpoints && count > Object.keys(before.endpoints).length) {
    throw new ModuleError('invalid_params', `An app may have at most ${limits.maxEndpoints} webhook endpoints (WEBHOOKS_MAX_ENDPOINTS_PER_APP); this config has ${count}.`, {
      details: { limit: 'WEBHOOKS_MAX_ENDPOINTS_PER_APP', value: limits.maxEndpoints },
      hint: "skill_info('webhooks')",
    });
  }
  return webhooksConfirmRequired(before, after);
}
