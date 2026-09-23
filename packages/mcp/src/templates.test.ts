import { describe, expect, it } from 'vitest';
import { REACT_VERSION, TEMPLATE_IMPORTS } from '@drobek/agent-dx';
import { Compiler } from '@drobek/compile';
import { TEMPLATES, templateFiles } from './templates.js';

describe('create_app templates', () => {
  const compiler = new Compiler();

  it.each(TEMPLATES)('%s compiles ok', async (name) => {
    const r = await compiler.compile(templateFiles(name, 'Test "app" <b>&'));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('react-ts: the 4 files, a pinned import map with ONE react, main.js + main.css', async () => {
    const files = templateFiles('react-ts', 'Demo');
    expect([...files.keys()].sort()).toEqual(['drobek.json', 'index.html', 'src/main.tsx', 'src/styles.css']);
    expect(JSON.parse(files.get('drobek.json')!)).toEqual({ imports: TEMPLATE_IMPORTS });
    for (const url of Object.values(TEMPLATE_IMPORTS)) expect(url).toContain(`@${REACT_VERSION}`);
    expect(files.get('index.html')).toContain('<script type="module" src="/main.js"></script>');
    expect(files.get('index.html')).toContain('<link rel="stylesheet" href="/main.css" />');

    const r = await compiler.compile(files);
    const js = r.outputs.get('main.js')!.toString('utf8');
    expect(js).toContain(`from "${TEMPLATE_IMPORTS['react/jsx-runtime']}"`);
    expect(js).toContain(`from "${TEMPLATE_IMPORTS['react-dom/client']}"`);
    expect(js).toContain(`from "${TEMPLATE_IMPORTS.react}"`);
    expect(r.outputs.get('main.css')!.toString('utf8')).toContain('font-family');
  });

  it('escapes the app name into HTML and TSX', () => {
    const files = templateFiles('react-ts', '</title><script>x</script>');
    expect(files.get('index.html')).not.toContain('<script>x</script>');
    expect(files.get('src/main.tsx')).toContain('const TITLE = "</title><script>x</script>";');
    expect(templateFiles('html', 'A & B').get('index.html')).toContain('<h1>A &#38; B</h1>');
  });
});
