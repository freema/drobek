import { expect, test } from '@playwright/test';
import { BASE_URL_MCP } from '../playwright.config';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';

/**
 * The `/mcp` request body cap (MCP_MAX_BODY_BYTES, default twice the 5 MiB
 * version total), read from the briefing the app's create_app returned:
 *  - a write_files call of about 1 MB across several files is written and
 *    compiles;
 *  - a request over the cap answers HTTP 413 with a JSON-RPC error that names
 *    the cap and says to split the write — raw, and through the SDK client as
 *    the error of the call (what an agent sees); nothing is written.
 */

interface JsonRpcError {
  jsonrpc: string;
  id: null;
  error: { code: number; message: string };
}

function capFrom(briefing: string): number {
  const m = /one MCP request of at most (\d+) (MiB|KiB)/.exec(briefing);
  expect(m, 'the briefing states the request cap').toBeTruthy();
  const [, n, unit] = m as RegExpExecArray;
  return Number(n) * (unit === 'MiB' ? 1024 * 1024 : 1024);
}

/** About 262 KB of text: four of them are a 1 MB write, each under the 512 KiB per-file limit. */
const PART = 'A line of the drobek request body e2e notes.\n'.repeat(5_800);

test('a 1 MB write_files fits; one over the MCP body cap answers a JSON-RPC 413 and writes nothing @local', async ({ page, request }) => {
  skipUnlessLocal();
  const mcp = await mcpClient(page, request, { tag: 'mcp-body' });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Body Limit E2E', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const cap = capFrom(created.json.briefing as string);
    expect(cap).toBeGreaterThan(1024 * 1024);

    const files = [0, 1, 2, 3].map((i) => ({ path: `notes/part-${i}.txt`, content: PART }));
    expect(files.reduce((sum, f) => sum + f.content.length, 0)).toBeGreaterThan(1_000_000);
    const big = await callTool(mcp.client, 'write_files', { app_id: appId, files, reasoning: 'A 1 MB write' });
    expect(big.isError, big.text.slice(0, 500)).toBe(false);
    expect(big.json).toMatchObject({ version: 2, compile: { ok: true } });
    expect(big.json.changed).toEqual(expect.arrayContaining(files.map((f) => f.path)));

    const tooBig = {
      app_id: appId,
      files: [{ path: 'notes/too-big.txt', content: 'x'.repeat(cap + 1024) }],
      reasoning: 'Too big',
    };
    const res = await request.post(`${BASE_URL_MCP}/mcp`, {
      headers: {
        Authorization: `Bearer ${mcp.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      data: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'write_files', arguments: tooBig } }),
    });
    expect(res.status()).toBe(413);
    const body = (await res.json()) as JsonRpcError;
    expect(body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    expect(body.error.message).toContain(`over ${cap} bytes`);
    expect(body.error.message).toContain('split the write into several write_files calls');

    await expect(mcp.client.callTool({ name: 'write_files', arguments: tooBig })).rejects.toThrow(
      /split the write into several write_files calls/
    );

    const after = await callTool(mcp.client, 'get_app', { app_id: appId });
    expect(after.isError, after.text.slice(0, 500)).toBe(false);
    expect(after.json.latest_version).toBe(2);
  } finally {
    await mcp.client.close();
  }
});
