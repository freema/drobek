import { describe, expect, it } from 'vitest';
import { isLintable, lintErrorSummary, lintFile, lintFiles } from './lint.js';

describe('isLintable', () => {
  it('scans html/css/js, ignores images/other', () => {
    expect(isLintable('index.html')).toBe(true);
    expect(isLintable('app.js')).toBe(true);
    expect(isLintable('app.jsx')).toBe(true);
    expect(isLintable('mod.mjs')).toBe(true);
    expect(isLintable('style.css')).toBe(true);
    expect(isLintable('logo.png')).toBe(false);
    expect(isLintable('data.json')).toBe(false);
  });
});

describe('lintFile — headless-browser gate (SECURITY)', () => {
  it('BLOCKS a puppeteer/chromium/playwright/headless reference', () => {
    for (const ref of ['puppeteer', 'chromium', 'playwright', 'headless']) {
      const r = lintFile('app.js', `import x from '${ref}';`);
      expect(r.errors.length, ref).toBe(1);
      expect(r.errors[0].rule).toBe('no-headless-browser');
    }
  });

  it('matches case-insensitively', () => {
    expect(lintFile('a.js', 'const P = require("Puppeteer")').errors).toHaveLength(1);
  });

  it('passes a clean file with no findings', () => {
    const r = lintFile('app.js', 'const sum = (a, b) => a + b;\nexport default sum;');
    expect(r.errors).toHaveLength(0);
  });
});

describe('lintFiles', () => {
  it('is ok when every file is clean', () => {
    const report = lintFiles([
      { path: 'index.html', content: '<!doctype html><html><body>hi</body></html>' },
      { path: 'app.js', content: 'console.log("hello")' },
    ]);
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  it('is NOT ok and summarizes when any file is blocked', () => {
    const report = lintFiles([
      { path: 'index.html', content: '<!doctype html><html></html>' },
      { path: 'bot.js', content: 'const b = await puppeteer.launch()' },
    ]);
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(lintErrorSummary(report)).toContain('bot.js');
    expect(lintErrorSummary(report)).toContain('puppeteer');
  });

  it('warns (non-blocking) on html with no doctype/html element', () => {
    const report = lintFiles([{ path: 'index.html', content: '<body>naked</body>' }]);
    expect(report.ok).toBe(true);
    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
  });
});
