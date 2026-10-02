import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@drobek/core';
import { createUploadToken, memoryUploadTokenStore } from './tokens.server.js';
import { createAssetUploadHandler } from './upload-http.server.js';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A handler whose editor check throws `err`, and a fresh upload URL for it. */
async function failingUpload(err: unknown): Promise<string> {
  const tokens = memoryUploadTokenStore();
  const handler = createAssetUploadHandler({
    limits: async () => ({ maxBytes: 1024, quota: 1024 * 1024 }),
    hint: (code) => `hint for ${code}`,
    mayUpload: () => Promise.reject(err),
    tokens,
    log: noopLogger,
  });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { token } = await createUploadToken(tokens, {
    appId: 'a',
    appSlug: 'film',
    workspaceId: 'w',
    name: 'clip.mp4',
    size: 4,
    contentType: 'video/mp4',
    userId: 'u',
    actorKind: 'agent',
    via: 'mcp',
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assets/upload/${token}`;
}

function timeout(code: string): Error {
  const cause = Object.assign(new Error('canceling statement due to lock timeout'), { name: 'PostgresError', severity: 'ERROR', code });
  return Object.assign(new Error('Failed query: select role\nparams: u', { cause }), { query: 'select role', params: ['u'] });
}

describe('the upload URL when the database fails', () => {
  it('a query the database cut off answers 503 busy (reason database_timeout) with the catalogue hint', async () => {
    const res = await fetch(await failingUpload(timeout('55P03')), { method: 'PUT', body: 'abcd' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'busy', reason: 'database_timeout', hint: 'hint for busy' });
    expect(JSON.stringify(body)).not.toMatch(/canceling|Failed query/);
  });

  it('any other failure stays 500 internal_error', async () => {
    const res = await fetch(await failingUpload(timeout('23505')), { method: 'PUT', body: 'abcd' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'internal_error', hint: 'hint for internal_error' });
  });
});
