import { describe, expect, it } from 'vitest';
import {
  BEACON_MAX_BYTES,
  DEFAULT_BEACON_APP_RATE_LIMIT,
  DEFAULT_BEACON_RATE_LIMIT,
  beaconLimitsFromEnv,
  beaconSizeVerdict,
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
