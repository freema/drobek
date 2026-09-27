/**
 * The confirm step of the operator's irreversible moderation actions (NSO-371):
 * a takedown (/admin/abuse) and blocking a workspace's publishing
 * (/admin/publishing). The first click is a GET that renders the confirm panel
 * (works without JavaScript); only the panel's POST carries `confirmed=1`, and
 * the actions refuse a takedown or block without it. Pure and client-safe.
 */

/** The form field the confirm panel posts; the actions require it. */
const CONFIRMED_FIELD = 'confirmed';

export function isConfirmed(form: FormData): boolean {
  return form.get(CONFIRMED_FIELD) === '1';
}

/**
 * Where Cancel returns to: only a path on the moderation pages, never another
 * origin (`//host`, `/\host`) or another page.
 */
export function safeModerationBack(raw: string | null | undefined, fallback = '/admin/abuse'): string {
  const v = (raw ?? '').trim();
  if (!/^\/admin\/(abuse|publishing)(?:[?#]|$)/.test(v)) return fallback;
  if (/[\\\s]/.test(v)) return fallback;
  return v;
}

export interface TakedownFacts {
  slug: string;
  published: boolean;
  publicUrl: string | null;
  domains: string[];
  openReports: number;
  galleryListed: boolean;
}

/** What a takedown does to this app, in the order the operator should read it. */
export function takedownEffects(f: TakedownFacts, reasonLabel: string): string[] {
  const hosts = [f.publicUrl ?? `${f.slug}'s public address`, 'its preview and version addresses', ...f.domains];
  const out = [
    f.published
      ? `Unpublishes it: ${hosts.join(', ')} answer 451 “unavailable” right away.`
      : `It is not published; its preview and version addresses${f.domains.length ? ` and ${f.domains.join(', ')}` : ''} answer 451 “unavailable” right away.`,
    'Blocks every change by its agent and in the dashboard until you restore it.',
  ];
  if (f.openReports > 0) out.push(`Resolves its ${f.openReports} open report${f.openReports === 1 ? '' : 's'}.`);
  if (f.galleryListed) out.push('Removes it from the public gallery.');
  out.push(`E-mails its owners the reason (${reasonLabel}).`);
  out.push('Restore lifts the lock later, but does not publish it again — its owner has to.');
  return out;
}
