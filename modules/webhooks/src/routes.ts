/**
 * `POST /__drobek/v1/webhooks/:endpoint` on every app host — one delivery
 * from another service, in this order:
 *
 *   1. the endpoint is configured and enabled (else 404, not logged);
 *   2. the app's WEBHOOKS_PER_APP_PER_MINUTE (429; only the first refusal of
 *      a window is logged, so a flood costs one row);
 *   3. the body size: the endpoint's `max_bytes`, at most
 *      WEBHOOKS_MAX_BODY_BYTES (413 `too_large`);
 *   4. the endpoint's secret is set (else 503 — the sender retries, and
 *      the delivery lands once the owner set it);
 *   5. the signature over the RAW body, constant-time, with the timestamp
 *      tolerance of the schemes that sign one (401 `rejected_signature`);
 *   6. the sender's event id, when the delivery carries one: a retry of a
 *      stored delivery answers 200 and stores nothing (`duplicate`);
 *   7. one record `{ source, event_type?, event_id?, received_at, payload }`
 *      in the endpoint's collection through the records module (its schema
 *      and the app's quotas apply) → 200 `{ ok, id }`; a record over the
 *      data module's DATA_MAX_DOC_BYTES → 413 `too_large` (a retry cannot
 *      fit either); any other refusal → 503 `collection_error` (the sender
 *      retries).
 *
 * The password gate does not apply (the route authenticates the sender
 * itself), and no SDK header is needed. Every delivery is logged without
 * its body, headers or the secret.
 */
import { ModuleError, isModuleError, type Limits, type ModuleContext, type ModuleRouter, type WebhookDeliveryStatus } from '@drobek/modules';
import { BODY_CEILING_BYTES, ENDPOINT_NAME_RE, endpointOf, secretOf, webhooksLimits, type WebhooksConfig } from './config.js';
import { claimEvent, logDelivery, releaseEvent } from './store.js';
import { eventFacts, payloadOf, verifyDelivery } from './verify.js';

type Ctx = ModuleContext<WebhooksConfig>;

const MINUTE_MS = 60_000;

/** The data module's per-record cap (DATA_MAX_DOC_BYTES) for this workspace, or null when it is not known. */
function recordLimit(limits: Limits): number | null {
  const v = limits.DATA_MAX_DOC_BYTES;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

function notFound(): ModuleError {
  return new ModuleError('not_found', 'No enabled webhook endpoint of this name in this app.', { hint: "skill_info('webhooks')" });
}

async function record(ctx: Ctx, endpoint: string, status: WebhookDeliveryStatus, httpStatus: number, bytes: number, extra: { reason?: string; recordId?: string } = {}) {
  await logDelivery(ctx.db, { appId: ctx.app.id, endpoint, status, httpStatus, bytes, reason: extra.reason ?? null, recordId: extra.recordId ?? null });
  ctx.log.info('webhooks: delivery', {
    event: 'webhooks_delivery',
    app_id: ctx.app.id,
    endpoint,
    status,
    bytes,
    ...(extra.reason ? { reason: extra.reason } : {}),
  });
}

export function registerRoutes(r: ModuleRouter<WebhooksConfig>): void {
  r.post(
    '/:endpoint',
    { bodyTypes: ['raw'], maxBodyBytes: BODY_CEILING_BYTES, csrf: 'same-origin', passwordGate: 'skip' },
    async (req, ctx) => {
      const name = req.params.endpoint;
      const endpoint = ENDPOINT_NAME_RE.test(name) ? endpointOf(ctx.config, name) : null;
      if (!endpoint || !endpoint.enabled) throw notFound();
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const bytes = body.length;
      const limits = webhooksLimits(await ctx.limits());

      const rate = await ctx.rateLimit('deliveries', 'app', limits.perAppPerMinute, MINUTE_MS);
      if (!rate.ok) {
        if (rate.count === limits.perAppPerMinute + 1) await record(ctx, name, 'rate_limited', 429, bytes, { reason: 'rate_limited' });
        throw new ModuleError('rate_limited', `This app takes at most ${limits.perAppPerMinute} webhook deliveries per minute.`, {
          details: { limit: 'WEBHOOKS_PER_APP_PER_MINUTE', value: limits.perAppPerMinute },
          headers: { 'Retry-After': String(rate.retryAfterSec) },
        });
      }

      const cap = Math.min(endpoint.max_bytes ?? limits.maxBodyBytes, limits.maxBodyBytes);
      if (bytes > cap) {
        await record(ctx, name, 'too_large', 413, bytes, { reason: 'too_large' });
        throw new ModuleError('payload_too_large', `The delivery has ${bytes} bytes; this endpoint takes at most ${cap}.`, {
          details: { limit: endpoint.max_bytes !== undefined && endpoint.max_bytes < limits.maxBodyBytes ? 'max_bytes' : 'WEBHOOKS_MAX_BODY_BYTES', value: cap },
        });
      }

      const secretName = secretOf(name, endpoint);
      const secret = await ctx.secrets.get(secretName);
      if (!secret) {
        await record(ctx, name, 'rejected_signature', 503, bytes, { reason: 'secret_not_set' });
        throw new ModuleError('webhook_secret_not_set', `The endpoint cannot verify deliveries yet: the app's owner has not set ${secretName} in the dashboard.`, {
          status: 503,
          details: { secret: secretName },
        });
      }

      const verified = verifyDelivery({
        scheme: endpoint.verify,
        secret,
        body,
        header: (h) => req.header(h),
        query: req.rawQuery,
        headerName: endpoint.header,
      });
      if (!verified.ok) {
        await record(ctx, name, 'rejected_signature', 401, bytes, { reason: verified.reason });
        throw new ModuleError('invalid_signature', 'The delivery is not signed with this endpoint\'s secret.', { status: 401, details: { reason: verified.reason } });
      }

      const payload = payloadOf(body, req.header('content-type'));
      const facts = eventFacts({ scheme: endpoint.verify, header: (h) => req.header(h), idHeader: endpoint.id_header, payload });
      if (facts.id !== null && !(await claimEvent(ctx.db, { appId: ctx.app.id, endpoint: name, eventId: facts.id }))) {
        await record(ctx, name, 'duplicate', 200, bytes, { reason: 'duplicate' });
        return { ok: true, duplicate: true };
      }

      const doc: Record<string, unknown> = {
        source: name,
        ...(facts.type !== null ? { event_type: facts.type } : {}),
        ...(facts.id !== null ? { event_id: facts.id } : {}),
        received_at: new Date().toISOString(),
        payload,
      };
      const recordCap = recordLimit(await ctx.limits());
      const recordBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
      if (recordCap !== null && recordBytes > recordCap) {
        if (facts.id !== null) await releaseEvent(ctx.db, { appId: ctx.app.id, endpoint: name, eventId: facts.id });
        await record(ctx, name, 'too_large', 413, bytes, { reason: 'record_too_large' });
        throw new ModuleError('payload_too_large', `The delivery makes a record of ${recordBytes} bytes; one record of the app may have at most ${recordCap}.`, {
          details: { limit: 'DATA_MAX_DOC_BYTES', value: recordCap },
        });
      }
      let stored: Record<string, unknown>;
      try {
        [stored] = await ctx.records.create(endpoint.collection, [doc]);
      } catch (err) {
        if (facts.id !== null) await releaseEvent(ctx.db, { appId: ctx.app.id, endpoint: name, eventId: facts.id });
        const reason = isModuleError(err) ? err.code : 'error';
        await record(ctx, name, 'collection_error', isModuleError(err) ? 503 : 500, bytes, { reason });
        if (!isModuleError(err)) throw err;
        throw new ModuleError('webhook_not_stored', `The delivery could not be stored in the collection "${endpoint.collection}" (${reason}).`, {
          status: 503,
          details: { reason, collection: endpoint.collection },
        });
      }
      const id = typeof stored?._id === 'string' ? stored._id : null;
      await record(ctx, name, 'accepted', 200, bytes, id ? { recordId: id } : {});
      return { ok: true, id };
    }
  );
}
