/**
 * The one look of the pages drobek draws itself for people outside the
 * dashboard: the app-host pages (not found, password, error, 451), the public
 * dashboard pages (sign-in, invite, report, preview feedback, error), the
 * e-mails and the preview widgets. Client-safe: plain values and strings, no
 * Node API, so the dashboard's browser bundle may import it through
 * `@drobek/core/platform-theme`.
 *
 * Colours are CSS custom properties (`--drobek-<name>`) set on `:root`, light
 * by default and dark under `prefers-color-scheme: dark`. E-mail keeps the
 * light values only (mail clients rewrite dark mode on their own). The
 * preview widget scripts carry a copy of these values (they import nothing).
 */

export interface PlatformPalette {
  /** Page background. */
  bg: string;
  /** Raised surfaces: inputs, context boxes, the widget's bar. */
  surface: string;
  /** Main text. */
  ink: string;
  /** Secondary text. */
  muted: string;
  /** Tertiary text: foot notes, hints. */
  faint: string;
  /** Hairlines and input borders. */
  line: string;
  /** The primary button. */
  accent: string;
  /** Text on the primary button. */
  accentInk: string;
  /** The mascot's crumb colour; focus rings and the widget's highlight. */
  crumb: string;
  danger: string;
  dangerBg: string;
  dangerLine: string;
  ok: string;
  okBg: string;
  okLine: string;
}

export const PLATFORM_COLORS: { light: PlatformPalette; dark: PlatformPalette } = {
  light: {
    bg: '#faf9f7',
    surface: '#ffffff',
    ink: '#1a1a1a',
    muted: '#555555',
    faint: '#8a8a8e',
    line: '#e7e5e1',
    accent: '#1a1a1a',
    accentInk: '#ffffff',
    crumb: '#d99a4e',
    danger: '#b91c1c',
    dangerBg: '#fef2f2',
    dangerLine: '#fecaca',
    ok: '#166534',
    okBg: '#f0fdf4',
    okLine: '#bbf7d0',
  },
  dark: {
    bg: '#161514',
    surface: '#201f1d',
    ink: '#ecebe8',
    muted: '#b4b2ad',
    faint: '#8a8884',
    line: '#363431',
    accent: '#ecebe8',
    accentInk: '#161514',
    crumb: '#e0a75f',
    danger: '#fca5a5',
    dangerBg: '#3a1d1d',
    dangerLine: '#7f2d2d',
    ok: '#86efac',
    okBg: '#13281a',
    okLine: '#245c37',
  },
};

export const PLATFORM_FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const PLATFORM_MONO_FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/** Corner radii: small controls, buttons and inputs, boxes. */
export const PLATFORM_RADIUS = { sm: '6px', md: '8px', lg: '12px' } as const;

/** The one shadow, for floating things (the preview widget, toasts). */
export const PLATFORM_SHADOW = '0 1px 2px rgba(0,0,0,.08),0 6px 20px rgba(0,0,0,.14)';

/** Spacing steps in rem. */
export const PLATFORM_SPACE = { xs: '0.35rem', sm: '0.6rem', md: '1rem', lg: '1.5rem', xl: '2.5rem' } as const;

/** The content column of a platform page. */
export const PLATFORM_PAGE_WIDTH = '34rem';

export type PlatformColor = keyof PlatformPalette;

const VAR_NAMES: Record<PlatformColor, string> = {
  bg: 'bg',
  surface: 'surface',
  ink: 'ink',
  muted: 'muted',
  faint: 'faint',
  line: 'line',
  accent: 'accent',
  accentInk: 'accent-ink',
  crumb: 'crumb',
  danger: 'danger',
  dangerBg: 'danger-bg',
  dangerLine: 'danger-line',
  ok: 'ok',
  okBg: 'ok-bg',
  okLine: 'ok-line',
};

/** `var(--drobek-<name>, <light value>)`: a colour that follows the scheme where the theme CSS is on the page, light elsewhere. */
export function platformColor(name: PlatformColor): string {
  return `var(--drobek-${VAR_NAMES[name]},${PLATFORM_COLORS.light[name]})`;
}

function declarations(p: PlatformPalette): string {
  return (Object.keys(VAR_NAMES) as PlatformColor[]).map((k) => `--drobek-${VAR_NAMES[k]}:${p[k]}`).join(';');
}

/** The custom properties: light on `:root`, dark under `prefers-color-scheme: dark`. */
export function platformThemeVars(): string {
  return (
    `:root{color-scheme:light dark;${declarations(PLATFORM_COLORS.light)}}` +
    `@media (prefers-color-scheme:dark){:root{${declarations(PLATFORM_COLORS.dark)}}}`
  );
}

/**
 * The stylesheet of a platform page: the custom properties, the page
 * (`body`), and the few classes every platform page builds from —
 * `.drobek-page` (the centred column), `.drobek-mark`, `.drobek-eyebrow`,
 * `.drobek-hint`, `.drobek-small`, `.drobek-label`, `.drobek-input`,
 * `.drobek-button` (+ `.drobek-button-secondary`), `.drobek-box`,
 * `.drobek-error`, `.drobek-ok`, `.drobek-foot`.
 */
export function platformPageCss(): string {
  const c = (n: PlatformColor) => `var(--drobek-${VAR_NAMES[n]})`;
  return [
    platformThemeVars(),
    `body{margin:0;background:${c('bg')};color:${c('ink')};font-family:${PLATFORM_FONT};-webkit-text-size-adjust:100%}`,
    `.drobek-page{box-sizing:border-box;max-width:${PLATFORM_PAGE_WIDTH};margin:0 auto;padding:${PLATFORM_SPACE.xl} 16px ${PLATFORM_SPACE.lg};line-height:1.55;font-size:1rem;color:${c('ink')};font-family:${PLATFORM_FONT}}`,
    `.drobek-page *,.drobek-page *::before,.drobek-page *::after{box-sizing:border-box}`,
    `.drobek-page h1{font-size:1.5rem;line-height:1.25;letter-spacing:-0.01em;margin:0 0 ${PLATFORM_SPACE.sm}}`,
    `.drobek-page p{margin:0 0 ${PLATFORM_SPACE.sm}}`,
    `.drobek-page a{color:${c('ink')};text-underline-offset:2px}`,
    `.drobek-page code{font-family:${PLATFORM_MONO_FONT};font-size:.85em}`,
    `.drobek-page :focus-visible{outline:2px solid ${c('crumb')};outline-offset:2px}`,
    `.drobek-mark{display:flex;align-items:center;gap:${PLATFORM_SPACE.sm};margin:0 0 ${PLATFORM_SPACE.lg};font-weight:600;letter-spacing:-0.02em;color:${c('ink')};text-decoration:none}`,
    `.drobek-mark svg{display:block}`,
    `.drobek-eyebrow{color:${c('muted')};font-size:.85rem;margin:0 0 .2rem}`,
    `.drobek-hint{color:${c('muted')};font-size:.95rem}`,
    `.drobek-small{color:${c('faint')};font-size:.82rem}`,
    `.drobek-label{display:block;font-size:.85rem;font-weight:600;margin:${PLATFORM_SPACE.md} 0 ${PLATFORM_SPACE.xs}}`,
    `.drobek-input{display:block;width:100%;padding:.6rem .75rem;font:inherit;font-size:1rem;color:${c('ink')};background:${c('surface')};border:1px solid ${c('line')};border-radius:${PLATFORM_RADIUS.md}}`,
    `textarea.drobek-input{min-height:8rem;resize:vertical}`,
    `.drobek-button{display:inline-block;margin-top:${PLATFORM_SPACE.md};padding:.6rem 1.1rem;font:inherit;font-size:1rem;font-weight:600;line-height:1.3;text-align:center;text-decoration:none;color:${c('accentInk')};background:${c('accent')};border:1px solid ${c('accent')};border-radius:${PLATFORM_RADIUS.md};cursor:pointer}`,
    `.drobek-button[disabled]{opacity:.6;cursor:default}`,
    `.drobek-button-block{display:block;width:100%}`,
    `.drobek-button-secondary{color:${c('ink')};background:${c('surface')};border-color:${c('line')}}`,
    `.drobek-page a.drobek-button{color:${c('accentInk')}}`,
    `.drobek-page a.drobek-button-secondary{color:${c('ink')}}`,
    `.drobek-box{border:1px solid ${c('line')};border-radius:${PLATFORM_RADIUS.lg};background:${c('surface')};padding:.7rem .9rem;margin:0 0 ${PLATFORM_SPACE.md}}`,
    `.drobek-error,.drobek-ok{border:1px solid;border-radius:${PLATFORM_RADIUS.md};padding:.6rem .8rem;font-size:.92rem;margin:${PLATFORM_SPACE.md} 0}`,
    `.drobek-error{color:${c('danger')};background:${c('dangerBg')};border-color:${c('dangerLine')}}`,
    `.drobek-ok{color:${c('ok')};background:${c('okBg')};border-color:${c('okLine')}}`,
    `.drobek-foot{margin-top:${PLATFORM_SPACE.xl};padding-top:${PLATFORM_SPACE.md};border-top:1px solid ${c('line')};color:${c('faint')};font-size:.82rem}`,
    `.drobek-foot a{color:${c('muted')}}`,
    `@media (prefers-reduced-motion:reduce){.drobek-page *{animation:none!important;transition:none!important}}`,
  ].join('\n');
}
