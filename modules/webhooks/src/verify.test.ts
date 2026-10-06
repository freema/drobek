/**
 * The verification schemes over the raw body (valid, tampered, replayed,
 * missing), the payload and event facts of a delivery.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TIMESTAMP_TOLERANCE_SEC, eventFacts, payloadOf, signatureBytes, verifyDelivery } from './verify.js';
import type { VerifyScheme } from './config.js';

const SECRET = ['test', 'signing', 'value', String(Date.now())].join('-');
const BODY = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', amount: 1200 }));
const NOW = 1_800_000_000;

const hex = (secret: string, ...parts: (string | Buffer)[]) => {
  const h = createHmac('sha256', secret);
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

function check(scheme: VerifyScheme, headers: Record<string, string>, opts: { body?: Buffer; query?: string; headerName?: string; now?: number; secret?: string } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return verifyDelivery({
    scheme,
    secret: opts.secret ?? SECRET,
    body: opts.body ?? BODY,
    header: (n) => lower[n.toLowerCase()] ?? null,
    query: opts.query ?? '',
    headerName: opts.headerName,
    now: opts.now ?? NOW,
  });
}

describe('hmac-sha256', () => {
  const sig = hex(SECRET, BODY);
  it('accepts hex, sha256=<hex> and base64 in the default header or the configured one', () => {
    expect(check('hmac-sha256', { 'X-Webhook-Signature': sig })).toEqual({ ok: true });
    expect(check('hmac-sha256', { 'X-Webhook-Signature': `sha256=${sig}` })).toEqual({ ok: true });
    expect(check('hmac-sha256', { 'X-Webhook-Signature': Buffer.from(sig, 'hex').toString('base64') })).toEqual({ ok: true });
    expect(check('hmac-sha256', { 'X-Signature': sig }, { headerName: 'X-Signature' })).toEqual({ ok: true });
  });
  it('refuses a tampered body, another secret, garbage and a missing header', () => {
    expect(check('hmac-sha256', { 'X-Webhook-Signature': sig }, { body: Buffer.from(`${BODY.toString()} `) })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check('hmac-sha256', { 'X-Webhook-Signature': sig }, { secret: `${SECRET}x` })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check('hmac-sha256', { 'X-Webhook-Signature': 'nope' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check('hmac-sha256', {})).toEqual({ ok: false, reason: 'missing_signature' });
    expect(check('hmac-sha256', { 'X-Webhook-Signature': sig }, { headerName: 'X-Other' })).toEqual({ ok: false, reason: 'missing_signature' });
  });
  it('signatureBytes reads only 32-byte signatures', () => {
    expect(signatureBytes(sig)?.length).toBe(32);
    expect(signatureBytes('ab')).toBeNull();
    expect(signatureBytes(Buffer.alloc(16).toString('base64'))).toBeNull();
  });
});

describe('stripe', () => {
  const header = (t: number, secret = SECRET, body = BODY) => `t=${t},v1=${hex(secret, `${t}.`, body)}`;
  it('accepts a fresh signature, also among several v1 values', () => {
    expect(check('stripe', { 'Stripe-Signature': header(NOW) })).toEqual({ ok: true });
    expect(check('stripe', { 'Stripe-Signature': `t=${NOW},v1=${'0'.repeat(64)},v1=${hex(SECRET, `${NOW}.`, BODY)},v0=abc` })).toEqual({ ok: true });
  });
  it('refuses a replayed (stale or future) timestamp, a tampered body, a moved timestamp and a missing header', () => {
    expect(check('stripe', { 'Stripe-Signature': header(NOW - TIMESTAMP_TOLERANCE_SEC - 1) })).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
    expect(check('stripe', { 'Stripe-Signature': header(NOW + TIMESTAMP_TOLERANCE_SEC + 1) })).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
    expect(check('stripe', { 'Stripe-Signature': header(NOW) }, { body: Buffer.from('{}') })).toEqual({ ok: false, reason: 'bad_signature' });
    const moved = header(NOW - 1000).replace(`t=${NOW - 1000}`, `t=${NOW}`);
    expect(check('stripe', { 'Stripe-Signature': moved })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check('stripe', {})).toEqual({ ok: false, reason: 'missing_signature' });
    expect(check('stripe', { 'Stripe-Signature': `t=${NOW}` })).toEqual({ ok: false, reason: 'missing_signature' });
  });
});

describe('github', () => {
  it('needs sha256=<hex> in X-Hub-Signature-256', () => {
    const sig = hex(SECRET, BODY);
    expect(check('github', { 'X-Hub-Signature-256': `sha256=${sig}` })).toEqual({ ok: true });
    expect(check('github', { 'X-Hub-Signature-256': sig })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check('github', { 'X-Hub-Signature-256': `sha256=${hex('other', BODY)}` })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check('github', { 'X-Webhook-Signature': `sha256=${sig}` })).toEqual({ ok: false, reason: 'missing_signature' });
  });
});

describe('none-with-token', () => {
  it('takes the token from the header or ?token=, compared in full', () => {
    expect(check('none-with-token', { 'X-Webhook-Token': SECRET })).toEqual({ ok: true });
    expect(check('none-with-token', {}, { query: `a=1&token=${encodeURIComponent(SECRET)}` })).toEqual({ ok: true });
    expect(check('none-with-token', { 'X-Key': SECRET }, { headerName: 'X-Key' })).toEqual({ ok: true });
    expect(check('none-with-token', { 'X-Webhook-Token': SECRET.slice(0, -1) })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check('none-with-token', {})).toEqual({ ok: false, reason: 'missing_signature' });
  });
});

describe('payload and event facts', () => {
  it('parses JSON, a form body and keeps anything else as text', () => {
    expect(payloadOf(BODY, 'application/json; charset=utf-8')).toEqual({ id: 'evt_1', type: 'payment.succeeded', amount: 1200 });
    expect(payloadOf(Buffer.from('a=1&b=x&_hp=1&a=2'), 'application/x-www-form-urlencoded')).toEqual({ a: '1', b: 'x' });
    expect(payloadOf(Buffer.from('{broken'), 'application/json')).toBe('{broken');
    expect(payloadOf(Buffer.from('<xml/>'), 'application/xml')).toBe('<xml/>');
    expect(payloadOf(Buffer.alloc(0), null)).toBe('');
  });
  it('reads the id and type per scheme, and only short printable values', () => {
    const header = (h: Record<string, string>) => (n: string) => h[n] ?? null;
    expect(eventFacts({ scheme: 'stripe', header: header({}), payload: { id: 'evt_1', type: 'charge.succeeded' } })).toEqual({ id: 'evt_1', type: 'charge.succeeded' });
    expect(eventFacts({ scheme: 'github', header: header({ 'x-github-delivery': 'd-1', 'x-github-event': 'push' }), payload: {} })).toEqual({ id: 'd-1', type: 'push' });
    expect(eventFacts({ scheme: 'hmac-sha256', header: header({ 'webhook-id': 'm1' }), payload: { event: 'entry.created' } })).toEqual({ id: 'm1', type: 'entry.created' });
    expect(eventFacts({ scheme: 'hmac-sha256', header: header({ 'x-id': 'm2' }), idHeader: 'X-Id', payload: 'text' })).toEqual({ id: 'm2', type: null });
    expect(eventFacts({ scheme: 'hmac-sha256', header: header({}), payload: 'text' })).toEqual({ id: null, type: null });
    expect(eventFacts({ scheme: 'hmac-sha256', header: header({ 'x-id': 'm2' }), idHeader: 'x-id', payload: { type: 'a\nb' } })).toEqual({ id: 'm2', type: null });
    expect(eventFacts({ scheme: 'stripe', header: header({}), payload: { id: 'x'.repeat(201) } }).id).toBeNull();
  });
});
