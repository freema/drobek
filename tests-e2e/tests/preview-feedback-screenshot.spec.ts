import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * A screenshot on a feedback note end to end on the local stack (the fixture
 * PNG stands in for a capture: the browser's tab picker cannot be driven).
 *
 *  - a member attaches the fixture on /feedback/new: with JavaScript the page
 *    shrinks it and shows a preview, without JavaScript the plain file input
 *    sends it; both notes store a re-encoded screenshot;
 *  - the Feedback tab shows a thumbnail; the full image route answers a WebP
 *    with nosniff to the member;
 *  - list_feedback lists `screenshot: { width, height, bytes }`, and
 *    get_feedback_screenshot answers a JPEG image block between the two text
 *    blocks of its untrusted envelope;
 *  - deleting the note makes the image route answer 404.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feedback-screenshot.png');

interface Created {
  app_id: string;
  slug: string;
}

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Screenshot demo</title></head><body><main><h1>Screenshot demo</h1></main></body></html>';

test.describe.configure({ mode: 'serial' });

test.describe('a screenshot on preview feedback @local', () => {
  let mcp: McpClient;
  let member: BrowserContext;
  let app: Created;
  let version = 0;
  let noteId = '';

  test.afterAll(async () => {
    await mcp?.client.close();
    await member?.close();
  });

  test('a member attaches the fixture PNG to a note; the page previews it before sending', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'feedback-shot', scope: FULL_SCOPE });
    member = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });
    app = (await callTool(mcp.client, 'create_app', { name: 'Screenshot demo', template: 'html' })).json as unknown as Created;
    const w = await callTool(mcp.client, 'write_files', { app_id: app.app_id, files: [{ path: 'index.html', content: PAGE }], reasoning: 'A page to review' });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    version = w.json.version as number;

    const popup = await member.newPage();
    await popup.goto(`${BASE_URL_WEB}/feedback/new?app=${app.slug}&v=${version}&path=/`);
    await expect(popup.getByTestId('feedback-screenshot-field')).toBeVisible();
    await popup.getByTestId('feedback-body').fill('The red button overlaps the card. The screenshot shows it.');
    await popup.getByTestId('feedback-screenshot-input').setInputFiles(FIXTURE);
    await expect(popup.getByTestId('feedback-screenshot-preview')).toBeVisible();
    await expect(popup.getByTestId('feedback-screenshot-preview')).toContainText('1440×900');
    await popup.getByTestId('feedback-send').click();
    await expect(popup.getByTestId('feedback-sent')).toBeVisible();
    await popup.close();
  });

  test('without JavaScript the file input alone sends the screenshot', async ({ browser }) => {
    skipUnlessLocal();
    const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await member.storageState() });
    try {
      const popup = await noJs.newPage();
      await popup.goto(`${BASE_URL_WEB}/feedback/new?app=${app.slug}&path=/about`);
      await expect(popup.getByTestId('feedback-capture')).toHaveCount(0);
      await popup.getByTestId('feedback-body').fill('Sent without JavaScript.');
      await popup.getByTestId('feedback-screenshot-input').setInputFiles(FIXTURE);
      await popup.getByTestId('feedback-send').click();
      await expect(popup.getByTestId('feedback-sent')).toBeVisible();
    } finally {
      await noJs.close();
    }
  });

  test('the Feedback tab shows a thumbnail; the full image is a WebP for members', async () => {
    skipUnlessLocal();
    const page = await member.newPage();
    await page.goto(`${BASE_URL_WEB}/workspaces/${mcp.workspace}/apps/${app.slug}/feedback`);
    const rows = page.getByTestId('feedback-row');
    await expect(rows).toHaveCount(2);
    const row = rows.filter({ hasText: 'The red button overlaps the card.' });
    noteId = (await row.getAttribute('data-feedback-id'))!;
    const thumb = row.getByTestId('feedback-screenshot-thumb');
    await expect(thumb).toBeVisible();
    await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    await expect(row.getByTestId('feedback-screenshot')).toContainText('1440×900');

    const full = await member.request.get(`${BASE_URL_WEB}/workspaces/${mcp.workspace}/apps/${app.slug}/feedback/${noteId}/screenshot`);
    expect(full.status()).toBe(200);
    expect(full.headers()['content-type']).toBe('image/webp');
    expect(full.headers()['x-content-type-options']).toBe('nosniff');
    expect(full.headers()['content-security-policy']).toBe("default-src 'none'; sandbox");
    const bytes = await full.body();
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect(bytes.equals(readFileSync(FIXTURE))).toBe(false);

    const outsider = await page.context().browser()!.newContext();
    try {
      const anon = await outsider.request.get(`${BASE_URL_WEB}/workspaces/${mcp.workspace}/apps/${app.slug}/feedback/${noteId}/screenshot`, { maxRedirects: 0 });
      expect(anon.status()).not.toBe(200);
    } finally {
      await outsider.close();
    }
  });

  test('list_feedback lists the screenshot; get_feedback_screenshot returns the image inside the envelope', async () => {
    skipUnlessLocal();
    const listed = await callTool(mcp.client, 'list_feedback', { app_id: app.app_id });
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain('get_feedback_screenshot');
    const notes = (listed.json as unknown as { notes: { id: string; screenshot: { width: number; height: number; bytes: number; url?: string } | null }[] }).notes;
    const note = notes.find((n) => n.id === noteId)!;
    expect(note.screenshot).toMatchObject({ width: 1440, height: 900 });
    expect(note.screenshot!.bytes).toBeGreaterThan(0);
    expect(note.screenshot!.url).toBeUndefined();
    expect(notes.every((n) => n.screenshot !== null)).toBe(true);

    const res = await mcp.client.callTool({ name: 'get_feedback_screenshot', arguments: { app_id: app.app_id, feedback_id: noteId } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeUndefined();
    const content = res.content as ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    const open = content[0] as { text: string };
    expect(open.text.startsWith('UNTRUSTED CONTENT:')).toBe(true);
    expect(open.text).toMatch(/<untrusted-feedback-screenshot app_id="[^"]+" feedback_id="fb_[0-9a-f]{24}" stored_width="1440" stored_height="900" width="1280" height="800" bytes="\d+" mime_type="image\/jpeg" nonce="[0-9a-f]{16}">/);
    const image = content[1] as { data: string; mimeType: string };
    expect(image.mimeType).toBe('image/jpeg');
    const jpeg = Buffer.from(image.data, 'base64');
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(jpeg.length).toBeLessThanOrEqual(400 * 1024);
    expect((content[2] as { text: string }).text).toMatch(/^<\/untrusted-feedback-screenshot nonce="[0-9a-f]{16}">/);
  });

  test('deleting the note makes the image route answer 404', async () => {
    skipUnlessLocal();
    const page = await member.newPage();
    await page.goto(`${BASE_URL_WEB}/workspaces/${mcp.workspace}/apps/${app.slug}/feedback`);
    const row = page.locator(`[data-feedback-id="${noteId}"]`);
    await row.getByTestId('feedback-delete').click();
    await page.locator(`[data-feedback-id="${noteId}"]`).getByTestId('feedback-delete-confirm').click();
    await expect(page.locator(`[data-feedback-id="${noteId}"]`)).toHaveCount(0);
    const gone = await member.request.get(`${BASE_URL_WEB}/workspaces/${mcp.workspace}/apps/${app.slug}/feedback/${noteId}/screenshot`);
    expect(gone.status()).toBe(404);
    const tool = await callTool(mcp.client, 'get_feedback_screenshot', { app_id: app.app_id, feedback_id: noteId });
    expect(tool.isError).toBe(true);
    expect(tool.json).toMatchObject({ code: 'not_found' });
  });
});
