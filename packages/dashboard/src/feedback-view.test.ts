import { describe, expect, it } from 'vitest';
import { anchorText, feedbackListState, feedbackSpot, noteOpenUrl } from './feedback-view.js';

describe('the Feedback tab view', () => {
  it('tells an empty app, all resolved, nothing resolved yet and a loading error apart', () => {
    expect(feedbackListState({ filter: 'open', rows: 0, open: 0, resolved: 0, error: null })).toBe('none');
    expect(feedbackListState({ filter: 'resolved', rows: 0, open: 0, resolved: 0, error: null })).toBe('none');
    expect(feedbackListState({ filter: 'open', rows: 0, open: 0, resolved: 3, error: null })).toBe('all-resolved');
    expect(feedbackListState({ filter: 'resolved', rows: 0, open: 2, resolved: 0, error: null })).toBe('none-resolved');
    expect(feedbackListState({ filter: 'open', rows: 2, open: 2, resolved: 0, error: null })).toBe('rows');
    expect(feedbackListState({ filter: 'open', rows: 0, open: 2, resolved: 0, error: 'stale' })).toBe('error');
  });

  it('reads a spot', () => {
    expect(anchorText(null)).toBe('the whole page');
    expect(anchorText({ x: 1, y: 2, vw: 3, vh: 4 })).toBe('x 1, y 2 in a 3×4 window');
    expect(anchorText({ x: 1, y: 2, vw: 3, vh: 4, selector: '#buy' })).toBe('x 1, y 2 in a 3×4 window — #buy');
    expect(anchorText({ x: 412, y: 230, vw: 1280, vh: 720, selector: '#buy', label: 'button#buy "Buy"' })).toBe('button#buy "Buy" · x 412, y 230 · 1280×720');
    expect(feedbackSpot(null)).toBeNull();
    expect(feedbackSpot({ x: 412, y: 230, vw: 1280, vh: 720, selector: '#buy', label: 'button#buy "Buy"' })).toEqual({
      label: 'button#buy "Buy"',
      where: 'x 412, y 230 · 1280×720',
      selector: '#buy',
    });
    expect(feedbackSpot({ x: 1, y: 2, vw: 3, vh: 4 })).toEqual({ label: null, where: 'x 1, y 2 · 3×4', selector: null });
  });

  it('opens the version the note was left on, else the preview', () => {
    const hosts = { preview: 'https://a--preview.x', version: (n: number) => `https://a--v${n}.x` };
    expect(noteOpenUrl({ versionNumber: 4, path: '/cart' }, hosts)).toBe('https://a--v4.x/cart');
    expect(noteOpenUrl({ versionNumber: null, path: '/' }, hosts)).toBe('https://a--preview.x/');
  });
});
