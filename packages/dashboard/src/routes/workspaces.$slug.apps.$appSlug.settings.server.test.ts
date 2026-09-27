/**
 * The Settings tab's gallery summary (NSO-371): absent without a gallery;
 * otherwise the app's gallery state (edited on Overview) and whether the
 * gallery website may frame a listed app, which the Embedding copy names as
 * an exception to the app's own list.
 */
import { describe, expect, it } from 'vitest';
import { settingsGallery } from './workspaces.$slug.apps.$appSlug.settings.server.js';

const app = {
  galleryListed: true,
  galleryDescription: 'A calendar',
  galleryHiddenAt: null,
  galleryAllowDuplicate: false,
  publishedVersionId: 'ver_1',
  lockedReason: null,
  visibility: 'public',
};

describe('settingsGallery', () => {
  it('is null when the server runs no gallery', () => {
    expect(settingsGallery(app, {})).toBeNull();
    expect(settingsGallery(app, { GALLERY_FRAME_ANCESTORS: 'https://gallery.example.com' })).toBeNull();
  });

  it('reports the listing and whether the gallery website may show previews', () => {
    expect(settingsGallery(app, { GALLERY_ENABLED: 'true' })).toEqual({
      listed: true,
      visible: true,
      hiddenByAdmin: false,
      previews: false,
    });
    expect(
      settingsGallery(app, { GALLERY_ENABLED: 'true', GALLERY_FRAME_ANCESTORS: 'https://gallery.example.com' })?.previews
    ).toBe(true);
  });

  it('a listed, password-protected or hidden app is not shown', () => {
    expect(settingsGallery({ ...app, visibility: 'password' }, { GALLERY_ENABLED: 'true' })).toMatchObject({
      listed: true,
      visible: false,
    });
    expect(settingsGallery({ ...app, galleryHiddenAt: new Date() }, { GALLERY_ENABLED: 'true' })).toMatchObject({
      hiddenByAdmin: true,
      visible: false,
    });
  });
});
