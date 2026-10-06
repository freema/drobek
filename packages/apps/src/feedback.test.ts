import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_BODY_MAX,
  FEEDBACK_PATH_MAX,
  FEEDBACK_RESOLUTION_NOTE_MAX,
  FEEDBACK_SELECTOR_MAX,
  feedbackLimits,
  feedbackVersionNumber,
  isFeedbackId,
  mayDeleteFeedback,
  normalizeFeedbackPath,
  parseFeedbackAnchor,
  parseFeedbackFilter,
  validateFeedbackBody,
  validateResolutionNote,
} from './feedback.js';

describe('feedback limits', () => {
  it('defaults to 500 open notes per app and 30 notes per account and hour', () => {
    expect(feedbackLimits({})).toEqual({ maxOpenPerApp: 500, perUserHour: 30 });
  });

  it('takes positive integers from the env and ignores anything else', () => {
    expect(feedbackLimits({ FEEDBACK_MAX_OPEN_PER_APP: '20', FEEDBACK_PER_USER_HOUR: '3' })).toEqual({ maxOpenPerApp: 20, perUserHour: 3 });
    expect(feedbackLimits({ FEEDBACK_MAX_OPEN_PER_APP: '0', FEEDBACK_PER_USER_HOUR: 'many' })).toEqual({ maxOpenPerApp: 500, perUserHour: 30 });
  });
});

describe('the context the widget passes along', () => {
  it('keeps an absolute path without its query and fragment', () => {
    expect(normalizeFeedbackPath('/shop/cart?x=1#top')).toBe('/shop/cart');
    expect(normalizeFeedbackPath('/a\u0000b\nc')).toBe('/abc');
    expect(normalizeFeedbackPath('/' + 'p'.repeat(FEEDBACK_PATH_MAX * 2))).toHaveLength(FEEDBACK_PATH_MAX);
  });

  it('turns anything that is not a path into /', () => {
    for (const raw of ['https://evil.example/x', '//evil.example', '/\\evil', '', 'relative', 42, null]) {
      expect(normalizeFeedbackPath(raw), String(raw)).toBe('/');
    }
  });

  it('reads the spot: rounded coordinates, the viewport, an optional one-line selector', () => {
    expect(parseFeedbackAnchor({ x: '10.4', y: 20, vw: '1280', vh: 800, selector: 'main > h1\n.title' })).toEqual({
      selector: 'main > h1 .title',
      x: 10,
      y: 20,
      vw: 1280,
      vh: 800,
    });
    expect(parseFeedbackAnchor({ x: 1, y: 2, vw: 3, vh: 4, selector: 's'.repeat(FEEDBACK_SELECTOR_MAX + 50) })?.selector).toHaveLength(
      FEEDBACK_SELECTOR_MAX
    );
  });

  it('a missing or out-of-range coordinate means a note on the whole page', () => {
    expect(parseFeedbackAnchor({})).toBeNull();
    expect(parseFeedbackAnchor({ x: -1, y: 2, vw: 3, vh: 4 })).toBeNull();
    expect(parseFeedbackAnchor({ x: 1, y: 2, vw: 0, vh: 4 })).toBeNull();
    expect(parseFeedbackAnchor({ x: 'NaN', y: 2, vw: 3, vh: 4 })).toBeNull();
    expect(parseFeedbackAnchor({ x: 1e9, y: 2, vw: 3, vh: 4 })).toBeNull();
  });

  it('a version is a positive integer, else unknown', () => {
    expect(feedbackVersionNumber('7')).toBe(7);
    expect(feedbackVersionNumber(0)).toBeNull();
    expect(feedbackVersionNumber('1.5')).toBeNull();
    expect(feedbackVersionNumber(undefined)).toBeNull();
  });
});

describe('the note', () => {
  it('needs text, keeps line breaks and drops other control characters', () => {
    expect(validateFeedbackBody('  The button\r\nis cut off\u0007  ')).toEqual({ ok: true, body: 'The button\nis cut off' });
    expect(validateFeedbackBody('   ')).toMatchObject({ ok: false });
    expect(validateFeedbackBody(undefined)).toMatchObject({ ok: false });
  });

  it(`is at most ${FEEDBACK_BODY_MAX} characters`, () => {
    expect(validateFeedbackBody('a'.repeat(FEEDBACK_BODY_MAX))).toMatchObject({ ok: true });
    const r = validateFeedbackBody('a'.repeat(FEEDBACK_BODY_MAX + 1));
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toContain(String(FEEDBACK_BODY_MAX));
  });

  it('a resolution note is optional and bounded', () => {
    expect(validateResolutionNote(undefined)).toEqual({ ok: true, note: null });
    expect(validateResolutionNote('  ')).toEqual({ ok: true, note: null });
    expect(validateResolutionNote(' Fixed in v4 ')).toEqual({ ok: true, note: 'Fixed in v4' });
    expect(validateResolutionNote('x'.repeat(FEEDBACK_RESOLUTION_NOTE_MAX + 1))).toMatchObject({ ok: false });
    expect(validateResolutionNote(5)).toMatchObject({ ok: false });
  });
});

describe('ids, filters and who may delete', () => {
  it('recognizes a note id', () => {
    expect(isFeedbackId(`fb_${'a1'.repeat(12)}`)).toBe(true);
    expect(isFeedbackId('fb_123')).toBe(false);
    expect(isFeedbackId(`fs_${'a1'.repeat(12)}`)).toBe(false);
  });

  it('filters open by default', () => {
    expect(parseFeedbackFilter('resolved')).toBe('resolved');
    expect(parseFeedbackFilter('all')).toBe('all');
    expect(parseFeedbackFilter('nonsense')).toBe('open');
    expect(parseFeedbackFilter(null)).toBe('open');
  });

  it('the author and a workspace admin may delete, nobody else', () => {
    const note = { authorUserId: 'u1' };
    expect(mayDeleteFeedback(note, { userId: 'u1', role: 'viewer' })).toBe(true);
    expect(mayDeleteFeedback(note, { userId: 'u2', role: 'workspace-admin' })).toBe(true);
    expect(mayDeleteFeedback(note, { userId: 'u2', role: 'editor' })).toBe(false);
    expect(mayDeleteFeedback({ authorUserId: null }, { userId: 'u2', role: 'editor' })).toBe(false);
  });
});
