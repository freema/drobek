/**
 * create_app starter templates (M0-05). Version 1 of every new app is one of
 * these, compiled like any write — so the preview works right away.
 *   react-ts — index.html, src/main.tsx, src/styles.css, drobek.json (pinned
 *              React import map from @drobek/agent-dx, one React on the page)
 *   html     — a single index.html
 */
import { TEMPLATE_IMPORTS } from '@drobek/agent-dx';

export const TEMPLATES = ['react-ts', 'html'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The template's files (path → UTF-8 text). `name` is HTML-escaped where it appears. */
export function templateFiles(template: TemplateName, name: string): Map<string, string> {
  const title = escapeHtml(name);
  if (template === 'html') {
    return new Map([
      [
        'index.html',
        [
          '<!doctype html>',
          '<html lang="en">',
          '  <head>',
          '    <meta charset="utf-8" />',
          '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
          `    <title>${title}</title>`,
          '    <style>',
          '      body { font-family: system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem; color: #1f2328; }',
          '      main { max-width: 40rem; margin: 0 auto; }',
          '    </style>',
          '  </head>',
          '  <body>',
          '    <main>',
          `      <h1>${title}</h1>`,
          '      <p>Built with drobek.</p>',
          '    </main>',
          '  </body>',
          '</html>',
          '',
        ].join('\n'),
      ],
    ]);
  }

  return new Map([
    [
      'index.html',
      [
        '<!doctype html>',
        '<html lang="en">',
        '  <head>',
        '    <meta charset="utf-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
        `    <title>${title}</title>`,
        '    <link rel="stylesheet" href="/main.css" />',
        '  </head>',
        '  <body>',
        '    <div id="root"></div>',
        '    <script type="module" src="/main.js"></script>',
        '  </body>',
        '</html>',
        '',
      ].join('\n'),
    ],
    [
      'src/main.tsx',
      [
        "import { StrictMode, useState } from 'react';",
        "import { createRoot } from 'react-dom/client';",
        "import './styles.css';",
        '',
        `const TITLE = ${JSON.stringify(name)};`,
        '',
        'function App() {',
        '  const [count, setCount] = useState(0);',
        '  return (',
        '    <main>',
        '      <h1>{TITLE}</h1>',
        '      <p>Built with drobek.</p>',
        '      <button onClick={() => setCount((n) => n + 1)}>Clicked {count} times</button>',
        '    </main>',
        '  );',
        '}',
        '',
        "createRoot(document.getElementById('root')!).render(",
        '  <StrictMode>',
        '    <App />',
        '  </StrictMode>',
        ');',
        '',
      ].join('\n'),
    ],
    [
      'src/styles.css',
      [
        'body {',
        '  font-family: system-ui, sans-serif;',
        '  margin: 0;',
        '  padding: 3rem 1.5rem;',
        '  color: #1f2328;',
        '}',
        '',
        'main {',
        '  max-width: 40rem;',
        '  margin: 0 auto;',
        '}',
        '',
        'button {',
        '  font: inherit;',
        '  padding: 0.5rem 1rem;',
        '  cursor: pointer;',
        '}',
        '',
      ].join('\n'),
    ],
    ['drobek.json', `${JSON.stringify({ imports: TEMPLATE_IMPORTS }, null, 2)}\n`],
  ]);
}
