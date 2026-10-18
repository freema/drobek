import { describe, expect, it } from 'vitest';
import { PLATFORM_COLORS, platformColor, platformPageCss, platformThemeVars } from './platform-theme.js';

describe('platform theme', () => {
  it('light and dark name the same colours', () => {
    expect(Object.keys(PLATFORM_COLORS.dark).sort()).toEqual(Object.keys(PLATFORM_COLORS.light).sort());
    for (const v of [...Object.values(PLATFORM_COLORS.light), ...Object.values(PLATFORM_COLORS.dark)]) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('the custom properties are light on :root and dark under prefers-color-scheme', () => {
    const css = platformThemeVars();
    expect(css).toContain(`:root{color-scheme:light dark;--drobek-bg:${PLATFORM_COLORS.light.bg}`);
    expect(css).toContain(`@media (prefers-color-scheme:dark){:root{--drobek-bg:${PLATFORM_COLORS.dark.bg}`);
    expect(css).toContain(`--drobek-accent-ink:${PLATFORM_COLORS.dark.accentInk}`);
  });

  it('a colour reference falls back to the light value where the theme CSS is absent', () => {
    expect(platformColor('accentInk')).toBe(`var(--drobek-accent-ink,${PLATFORM_COLORS.light.accentInk})`);
  });

  it('the page stylesheet carries the variables, the page and the shared classes, and nothing that loads', () => {
    const css = platformPageCss();
    expect(css.startsWith(platformThemeVars())).toBe(true);
    for (const cls of ['.drobek-page', '.drobek-mark', '.drobek-input', '.drobek-button', '.drobek-error', '.drobek-ok', '.drobek-foot']) expect(css).toContain(cls);
    expect(css).toContain('prefers-reduced-motion');
    expect(css).not.toMatch(/url\(|@import|<\/style/i);
  });
});
