import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WebhookEndpointsPanel, type WebhooksPanelData } from './webhook-endpoints.js';

const endpoint = (over: Partial<NonNullable<WebhooksPanelData['endpoints']>[number]> = {}) => ({
  name: 'payments',
  url: 'https://shop.apps.example/__drobek/v1/webhooks/payments',
  collection: 'payments',
  verify: 'hmac-sha256',
  signed: true,
  secret: 'WEBHOOK_SECRET_PAYMENTS',
  enabled: true,
  last_delivery_at: null,
  last_status: null,
  hasSecret: false,
  ...over,
});

const render = (data: WebhooksPanelData) => renderToStaticMarkup(<WebhookEndpointsPanel data={data} />);

describe('WebhookEndpointsPanel', () => {
  it('tells an empty list, no deliveries and a loading error apart', () => {
    const empty = render({ endpoints: [], deliveries: [] });
    expect(empty).toContain('data-testid="webhooks-empty"');
    expect(empty).toContain('data-testid="webhooks-deliveries-empty"');
    const broken = render({ endpoints: null, deliveries: [] });
    expect(broken).toContain('data-testid="webhooks-load-error"');
    expect(broken).not.toContain('webhooks-empty');
  });

  it('shows the copyable address, the verification, the secret status and the deliveries with their reason', () => {
    const html = render({
      endpoints: [endpoint(), endpoint({ name: 'forms', verify: 'none-with-token', signed: false, hasSecret: true, last_status: 'accepted' })],
      deliveries: [
        { endpoint: 'payments', status: 'rejected_signature', http_status: 401, bytes: 42, reason: 'bad_signature', record_id: null, received_at: '2026-10-06T10:00:00.000Z' },
        { endpoint: 'payments', status: 'collection_error', http_status: 503, bytes: 42, reason: 'some_new_code', record_id: null, received_at: '2026-10-06T09:00:00.000Z' },
      ],
    });
    expect(html).toContain('https://shop.apps.example/__drobek/v1/webhooks/payments');
    expect(html).toContain('data-testid="webhook-url-payments"');
    expect(html).toContain('not set: deliveries are refused until you set it below');
    expect(html).toContain('a shared token, no signature');
    expect(html).toContain('the signature does not match');
    expect(html).toContain('some_new_code');
    expect(html).toContain('data-testid="webhook-deliveries"');
  });
});
