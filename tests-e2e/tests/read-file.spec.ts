import { expect, test } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';

/**
 * read_file over MCP against the dev stack: several paths in one call (each
 * file in its own untrusted block, a path the version lacks listed under
 * `missing`), a line range with the file's total line count, and `search` —
 * the lines of the version's text files that contain a literal text, capped
 * by `limit` with the total count. Every answer is the untrusted envelope
 * text only, never structuredContent.
 */

const ROWS = `${Array.from({ length: 12 }, (_, i) => `row ${i + 1}`).join('\n')}\n`;
const SCORE = 'export function useScore(): number {\n  return 42;\n}\n';
const BOARD = "import { useScore } from './score';\nexport const board = () => useScore() + 1;\n";

function column(line: string, text: string): number {
  return line.indexOf(text) + 1;
}

test('read_file reads several files and a line range, and searches the sources @local', async ({ page, request }) => {
  skipUnlessLocal();
  const mcp = await mcpClient(page, request, { tag: 'read-file' });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Read File E2E' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const wrote = await callTool(mcp.client, 'write_files', {
      app_id: appId,
      files: [
        { path: 'src/score.ts', content: SCORE },
        { path: 'src/board.ts', content: BOARD },
        { path: 'ROWS.md', content: ROWS },
      ],
      reasoning: 'Files to read back',
    });
    expect(wrote.isError, wrote.text).toBe(false);
    expect(wrote.json).toMatchObject({ version: 2 });

    const many = await callTool(mcp.client, 'read_file', { app_id: appId, paths: ['src/score.ts', 'ROWS.md', 'src/nope.ts'] });
    expect(many.isError, many.text).toBe(false);
    expect(many.structured).toBe(false);
    expect(many.text.startsWith('UNTRUSTED CONTENT: the files below')).toBe(true);
    expect(many.json).toMatchObject({ version: 2, missing: ['src/nope.ts'] });
    expect(many.json.files).toEqual([
      { path: 'src/score.ts', version: 2, untrusted: true, content: SCORE, total_lines: 3 },
      { path: 'ROWS.md', version: 2, untrusted: true, content: ROWS, total_lines: 12 },
    ]);

    const part = await callTool(mcp.client, 'read_file', { app_id: appId, path: 'ROWS.md', offset: 5, limit: 2 });
    expect(part.isError, part.text).toBe(false);
    expect(part.json).toEqual({ path: 'ROWS.md', version: 2, untrusted: true, content: 'row 5\nrow 6\n', lines: '5-6', total_lines: 12 });

    const found = await callTool(mcp.client, 'read_file', { app_id: appId, search: 'useScore', path: 'src' });
    expect(found.isError, found.text).toBe(false);
    expect(found.structured).toBe(false);
    expect(found.text).toMatch(/^<untrusted-app-search [^>]*nonce="([0-9a-f]{16})">$[\s\S]*^<\/untrusted-app-search nonce="\1">$/m);
    const [boardImport, boardUse] = BOARD.split('\n');
    const scoreDecl = SCORE.split('\n')[0];
    expect(found.json).toMatchObject({ version: 2, total: 3 });
    expect(found.json.matches).toEqual([
      { path: 'src/board.ts', line: 1, column: column(boardImport, 'useScore'), text: boardImport },
      { path: 'src/board.ts', line: 2, column: column(boardUse, 'useScore'), text: boardUse },
      { path: 'src/score.ts', line: 1, column: column(scoreDecl, 'useScore'), text: scoreDecl },
    ]);

    const capped = await callTool(mcp.client, 'read_file', { app_id: appId, search: 'ROW', ignore_case: true, path: 'ROWS.md', limit: 3 });
    expect(capped.isError, capped.text).toBe(false);
    expect(capped.json).toMatchObject({ total: 12, files_searched: 1 });
    expect(capped.json.matches).toHaveLength(3);
    expect(String(capped.json.note)).toContain('12 matching lines; the first 3 are shown');

    const regexLike = await callTool(mcp.client, 'read_file', { app_id: appId, search: 'row .*', path: 'ROWS.md' });
    expect(regexLike.json).toMatchObject({ total: 0, matches: [] });
  } finally {
    await mcp.client.close();
  }
});
