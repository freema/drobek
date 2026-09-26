/**
 * The app Overview's "Gallery" section (NSO-340): whether the app is in the
 * server's public gallery, and — for editor+ — "Show in the gallery" + the
 * public one-line description + Save (intent `gallery` of appAction).
 * Listing needs a published app; a super-admin's hide overrides the owner.
 * Rendered only when the server runs a gallery (GALLERY_ENABLED).
 */
import { Form } from 'react-router';
import { controls } from '@drobek/tenancy/layout';
import { appStyles } from './app-header.js';

export interface GallerySectionData {
  listed: boolean;
  description: string | null;
  hiddenByAdmin: boolean;
  visible: boolean;
  published: boolean;
  passwordProtected: boolean;
  descriptionMax: number;
}

const s = appStyles;

const styles = {
  section: { marginTop: '2.25rem' },
  h2: { fontSize: '1.15rem', margin: '0 0 0.35rem' },
  hint: { color: '#555', fontSize: '0.9rem', margin: '0 0 0.6rem' },
  check: { display: 'inline-flex', gap: '0.4rem', alignItems: 'center', fontSize: '0.92rem', minHeight: '2.25rem' },
  notice: {
    background: '#fffbeb',
    border: '1px solid #fde68a',
    color: '#78350f',
    borderRadius: '8px',
    padding: '0.55rem 0.8rem',
    fontSize: '0.9rem',
    margin: '0.5rem 0',
  },
} as const;

type GalleryStatus = 'visible' | 'listed' | 'unlisted' | 'hidden';

function status(g: GallerySectionData): { state: GalleryStatus; text: string } {
  if (g.hiddenByAdmin) return { state: 'hidden', text: 'Hidden by the server operator' };
  if (g.visible) return { state: 'visible', text: 'Shown in the gallery' };
  if (g.listed) return { state: 'listed', text: 'Listed, but not shown right now' };
  return { state: 'unlisted', text: 'Not in the gallery' };
}

export function GallerySection({ gallery, canEdit, busy }: { gallery: GallerySectionData; canEdit: boolean; busy: boolean }) {
  const now = status(gallery);
  // A hidden entry can still be unlisted; listing it (or listing an unpublished app) is refused.
  const canList = gallery.published && !gallery.hiddenByAdmin;
  const editable = canEdit && (canList || gallery.listed);
  return (
    <section style={styles.section} data-testid="gallery-section">
      <h2 style={styles.h2}>Gallery</h2>
      <p style={styles.hint}>
        List the app in this server&apos;s public gallery. Anyone can see its name, the description below and a link to
        its production address. Unpublishing the app, or a takedown, removes it from the gallery.
      </p>
      <p style={s.inline}>
        Now:{' '}
        <strong data-testid="gallery-status" data-state={now.state}>
          {now.text}
        </strong>
        {gallery.listed && gallery.description ? <span style={s.muted}>“{gallery.description}”</span> : null}
      </p>
      {gallery.hiddenByAdmin ? (
        <p style={styles.notice} role="status" data-testid="gallery-hidden-notice">
          The operator of this server hid this app from the gallery, so it cannot be listed there.
        </p>
      ) : null}
      {gallery.listed && !gallery.visible && !gallery.hiddenByAdmin && gallery.passwordProtected ? (
        <p style={styles.notice} role="status">
          Password-protected apps are not shown in the gallery. Make the app public in Settings to show it.
        </p>
      ) : null}
      {canEdit ? (
        <Form method="post" style={s.panel} data-testid="gallery-form">
          <input type="hidden" name="intent" value="gallery" />
          {!gallery.published && !gallery.listed ? (
            <p style={{ ...styles.hint, margin: '0 0 0.5rem' }} data-testid="gallery-needs-publish">
              Publish the app first — only a published app can be listed.
            </p>
          ) : null}
          <div style={controls.row}>
            <label style={styles.check}>
              <input
                type="checkbox"
                name="listed"
                defaultChecked={gallery.listed}
                disabled={!editable || (!gallery.listed && !canList)}
                data-testid="gallery-listed"
              />
              Show in the gallery
            </label>
          </div>
          <div style={{ ...controls.row, marginTop: '0.5rem' }}>
            <label style={{ ...controls.field, flex: '1 1 22rem' }}>
              <span style={controls.label}>Public description</span>
              <input
                type="text"
                name="description"
                defaultValue={gallery.description ?? ''}
                maxLength={gallery.descriptionMax}
                placeholder="One or two sentences about what the app does."
                disabled={!editable}
                style={{ ...s.input, width: '100%' }}
                data-testid="gallery-description"
              />
            </label>
            <button type="submit" style={s.button} disabled={busy || !editable} data-testid="gallery-save">
              Save
            </button>
          </div>
          <p style={{ ...s.muted, fontSize: '0.8rem', margin: '0.4rem 0 0' }}>
            Plain text, at most {gallery.descriptionMax} characters. Agents can list the app too, but only after you
            say yes to them.
          </p>
        </Form>
      ) : null}
    </section>
  );
}
