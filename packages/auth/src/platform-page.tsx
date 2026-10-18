/**
 * <PlatformPage>: the frame of the dashboard pages people see before or
 * outside the signed-in dashboard (sign-in, invite, report, preview feedback,
 * the error page) — the same look as the app-host pages and the e-mails
 * (@drobek/core/platform-theme): the small mascot and wordmark on top, one
 * centred column, light or dark after the visitor's system setting. The
 * stylesheet travels with the page, so the rest of the dashboard keeps its
 * own look. Client-safe.
 */
import type { ReactNode } from 'react';
import { platformPageCss } from '@drobek/core/platform-theme';
import { DrobekMark } from './mark.js';

const CSS = platformPageCss();

export function PlatformPage({ page, children }: { page: string; children: ReactNode }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <main className="drobek-page" data-drobek-page={page}>
        <div className="drobek-mark">
          <DrobekMark size={32} idle />
          <span>drobek</span>
        </div>
        {children}
      </main>
    </>
  );
}
