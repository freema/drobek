import { describe, expect, it } from 'vitest';
import {
  BEACON_MAX_BYTES,
  DEFAULT_BEACON_APP_RATE_LIMIT,
  DEFAULT_BEACON_RATE_LIMIT,
  beaconLimitsFromEnv,
  beaconSizeVerdict,
  extractBatch,
  extractEvents,
  shouldSample,
} from './limits.js';
import { MAX_EVENTS_PER_BATCH } from './sanitize.js';

describe('beaconSizeVerdict', () => {
  it('accepts a body at the cap and rejects one over it', () => {
    expect(beaconSizeVerdict(BEACON_MAX_BYTES).ok).toBe(true);
    expect(beaconSizeVerdict(BEACON_MAX_BYTES + 1).ok).toBe(false);
  });
});

describe('shouldSample', () => {
  it('keeps everything at rate 1', () => {
    expect(shouldSample(1, 0.99)).toBe(true);
    expect(shouldSample(1, 0)).toBe(true);
  });
  it('drops everything at rate 0', () => {
    expect(shouldSample(0, 0)).toBe(false);
  });
  it('keeps rnd < rate', () => {
    expect(shouldSample(0.5, 0.4)).toBe(true);
    expect(shouldSample(0.5, 0.6)).toBe(false);
  });
});

describe('extractEvents', () => {
  it('accepts a bare array', () => {
    expect(extractEvents([{ a: 1 }, { b: 2 }], 20)).toHaveLength(2);
  });
  it('accepts an { events: [] } envelope', () => {
    expect(extractEvents({ events: [{ a: 1 }] }, 20)).toHaveLength(1);
  });
  it('wraps a single bare event object', () => {
    expect(extractEvents({ message: 'x' }, 20)).toHaveLength(1);
  });
  it('caps to the max batch size', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ i }));
    expect(extractEvents(many, MAX_EVENTS_PER_BATCH)).toHaveLength(
      MAX_EVENTS_PER_BATCH
    );
  });
  it('is empty for a non-object payload', () => {
    expect(extractEvents(null, 20)).toEqual([]);
    expect(extractEvents(42, 20)).toEqual([]);
  });
});

describe('extractBatch', () => {
  it('reads the version and the page load next to the events', () => {
    expect(extractBatch({ version: 7, load: true, events: [{ message: 'x' }] }, 20)).toEqual({
      events: [{ message: 'x' }],
      version: 7,
      load: true,
    });
  });
  it('a page load alone is no event', () => {
    expect(extractBatch({ version: 7, load: true }, 20)).toEqual({ events: [], version: 7, load: true });
    expect(extractBatch({ version: 7, load: true, events: [] }, 20).events).toEqual([]);
  });
  it('only load: true is a page load; a bad version is none', () => {
    expect(extractBatch({ version: '7', load: 'yes', events: [] }, 20)).toEqual({ events: [], version: null, load: false });
    expect(extractBatch({ version: -1, events: [] }, 20).version).toBeNull();
  });
  it('keeps the old shapes: a bare array or a bare event, no version', () => {
    expect(extractBatch([{ a: 1 }], 20)).toEqual({ events: [{ a: 1 }], version: null, load: false });
    expect(extractBatch({ type: 'error', message: 'x' }, 20)).toEqual({ events: [{ type: 'error', message: 'x' }], version: null, load: false });
    expect(extractBatch(null, 20)).toEqual({ events: [], version: null, load: false });
  });
});

describe('beaconLimitsFromEnv', () => {
  it('uses defaults for empty env', () => {
    const l = beaconLimitsFromEnv({});
    expect(l.rateLimit).toBe(DEFAULT_BEACON_RATE_LIMIT);
    expect(l.appRateLimit).toBe(DEFAULT_BEACON_APP_RATE_LIMIT);
    expect(l.sampleRate).toBe(1);
  });
  it('the per-app aggregate cap is >= the per-IP cap by default', () => {
    // The IP-independent cap must be at least as permissive as one client's,
    // otherwise a single legit client could trip the aggregate cap.
    expect(DEFAULT_BEACON_APP_RATE_LIMIT).toBeGreaterThanOrEqual(
      DEFAULT_BEACON_RATE_LIMIT
    );
  });
  it('reads overrides and ignores invalid values', () => {
    const l = beaconLimitsFromEnv({
      BEACON_RATE_LIMIT: '5',
      BEACON_APP_RATE_LIMIT: '50',
      BEACON_SAMPLE_RATE: '0.25',
      BEACON_MAX_EVENTS_PER_APP: 'nope',
    });
    expect(l.rateLimit).toBe(5);
    expect(l.appRateLimit).toBe(50);
    expect(l.sampleRate).toBe(0.25);
    expect(l.maxEventsPerApp).toBe(500); // invalid → default
  });
});
