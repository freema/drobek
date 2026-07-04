import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE,
  dedupKey,
  fileHintFromStack,
  redact,
  sanitizeEvent,
} from './sanitize.js';

describe('redact', () => {
  it('strips email addresses', () => {
    expect(redact('failed for alice@example.com now')).toBe(
      'failed for [redacted-email] now'
    );
  });

  it('strips JWT-shaped tokens', () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4';
    expect(redact(`token=${jwt}`).includes(jwt)).toBe(false);
  });

  it('strips Bearer tokens', () => {
    expect(redact('Authorization Bearer abcDEF123456ghiJKL').includes('abcDEF')).toBe(
      false
    );
  });

  it('redacts cookie / authorization / token key=value pairs', () => {
    const out = redact('Cookie: session=supersecretvalue; foo=bar');
    expect(out.includes('supersecretvalue')).toBe(false);
    const auth = redact('authorization=Basic short');
    expect(auth.includes('Basic')).toBe(false);
  });

  it('redacts long high-entropy runs', () => {
    const secret = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    expect(redact(`sid ${secret}`).includes(secret)).toBe(false);
  });
});

describe('sanitizeEvent', () => {
  it('drops unknown fields and keeps only the known shape', () => {
    const s = sanitizeEvent({
      type: 'error',
      message: 'boom',
      stack: 'Error: boom\n at app.js:1:1',
      url: 'https://x/app',
      ua: 'Mozilla',
      ts: 1_777_000_000_000,
      cookie: 'secret=abc',
      password: 'hunter2',
      extra: { nested: true },
    });
    expect(Object.keys(s).sort()).toEqual(
      ['message', 'stack', 'ts', 'type', 'ua', 'url'].sort()
    );
    expect((s as unknown as Record<string, unknown>).cookie).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).password).toBeUndefined();
  });

  it('sanitizes secret-shaped values inside the kept fields', () => {
    const s = sanitizeEvent({
      type: 'error',
      message: 'login failed for bob@corp.io token=Bearer ABCDEFGHIJKLMNOP',
      url: 'https://x/app?token=eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMe',
    });
    expect(s.message.includes('bob@corp.io')).toBe(false);
    expect(s.url.includes('eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMe')).toBe(false);
  });

  it('coerces an unknown type to error', () => {
    expect(sanitizeEvent({ type: 'weird', message: 'x' }).type).toBe('error');
    expect(
      sanitizeEvent({ type: 'unhandledrejection', message: 'x' }).type
    ).toBe('unhandledrejection');
  });

  it('truncates an over-long message', () => {
    // Spaced words so the long-token redactor doesn't collapse it first.
    const long = 'boom '.repeat(MAX_MESSAGE);
    const s = sanitizeEvent({ type: 'error', message: long });
    expect(s.message.length).toBeLessThanOrEqual(MAX_MESSAGE + 1); // + ellipsis
    expect(s.message.endsWith('…')).toBe(true);
  });

  it('nulls an implausible timestamp and keeps a valid one', () => {
    expect(sanitizeEvent({ type: 'error', message: 'x', ts: 5 }).ts).toBeNull();
    expect(
      sanitizeEvent({ type: 'error', message: 'x', ts: 'nope' }).ts
    ).toBeNull();
    const valid = Date.now();
    expect(sanitizeEvent({ type: 'error', message: 'x', ts: valid }).ts).toBe(
      valid
    );
  });

  it('falls back to a placeholder for a missing message', () => {
    expect(sanitizeEvent({ type: 'error' }).message).toBe('(no message)');
  });
});

describe('dedupKey', () => {
  it('is stable for the same message + stack head', () => {
    const a = dedupKey('boom', 'Error: boom\n at app.js:1:1\n at b.js:2:2');
    const b = dedupKey('boom', 'Error: boom\n at app.js:1:1\n at DIFFERENT:9:9');
    // Only the first two stack lines participate → same head, same key.
    expect(a).toBe(b);
  });

  it('differs for a different message', () => {
    expect(dedupKey('boom', null)).not.toBe(dedupKey('bang', null));
  });

  it('is 32 hex chars', () => {
    expect(dedupKey('x', null)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('fileHintFromStack', () => {
  it('extracts the first file:line:col', () => {
    expect(fileHintFromStack('Error\n at foo (app.js:42:13)')).toBe('app.js:42:13');
  });
  it('returns null with no location', () => {
    expect(fileHintFromStack('Error: no frames')).toBeNull();
    expect(fileHintFromStack(null)).toBeNull();
  });
});
