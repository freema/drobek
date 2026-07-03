import { describe, expect, it } from 'vitest';
import { loader as llmsTxt } from './llms-txt';
import { loader as llmsFull } from './llms-full-txt';

describe('/llms.txt loader', () => {
  it('serves text/plain with the /llms.txt title + a tool name', async () => {
    const res = llmsTxt();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body.startsWith('# drobek')).toBe(true);
    expect(body).toContain('deploy_init');
  });
});

describe('/llms-full.txt loader', () => {
  it('serves text/plain with every tool + the error catalogue', async () => {
    const res = llmsFull();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    for (const name of [
      'whoami',
      'list_apps',
      'deploy_init',
      'deploy_commit',
      'deploy_status',
      'rollback',
      'collection_define',
      'record_create',
      'record_read',
      'record_update',
      'record_delete',
      'record_query',
    ]) {
      expect(body).toContain(name);
    }
    expect(body).toContain('## Error catalogue');
    expect(body).toContain('validation_failed');
  });
});
