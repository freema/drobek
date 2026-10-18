/**
 * The platform theme as the preview's widgets inline it into their shadow
 * roots at build time (the scripts import nothing): CSS custom properties on
 * `:host`, light by default and dark under `prefers-color-scheme: dark`.
 */
import { PLATFORM_COLORS, type PlatformPalette } from '@drobek/core/platform-theme';

function themeVars(p: PlatformPalette): string {
  return `--surface:${p.surface};--ink:${p.ink};--muted:${p.muted};--line:${p.line};--accent:${p.accent};--accent-ink:${p.accentInk};--crumb:${p.crumb};--danger:${p.danger}`;
}

/** `:host` with the light values, and the dark ones under `prefers-color-scheme: dark`. */
export function widgetThemeCss(): string {
  return `:host{${themeVars(PLATFORM_COLORS.light)}}@media (prefers-color-scheme:dark){:host{${themeVars(PLATFORM_COLORS.dark)}}}`;
}
