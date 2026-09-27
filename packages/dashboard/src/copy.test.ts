import { describe, expect, it } from 'vitest';
import { copyText } from './copy.js';

describe('copyText', () => {
  it('reports copied when the clipboard accepts the text', async () => {
    const written: string[] = [];
    const result = await copyText('https://drobek.example.com/mcp', {
      writeText: async (t) => {
        written.push(t);
      },
    });
    expect(result).toBe('copied');
    expect(written).toEqual(['https://drobek.example.com/mcp']);
  });

  it('reports failed when the browser refuses the write', async () => {
    const result = await copyText('x', {
      writeText: async () => {
        throw new DOMException('Write permission denied.', 'NotAllowedError');
      },
    });
    expect(result).toBe('failed');
  });

  it('reports failed when there is no Clipboard API (plain-http origin)', async () => {
    expect(await copyText('x', undefined)).toBe('failed');
  });
});
