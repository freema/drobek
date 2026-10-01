import { expect, test } from '@playwright/test';
import { hostRequest, previewHost, urlOf } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * Module forms that read as settings, the cases dashboard-modules.spec.ts
 * leaves out:
 *  - files: a rule the owner did not touch keeps its exact text (`admin|user`
 *    stays in that order), a largest-file size set in bytes over MCP comes
 *    back byte for byte, and unchecking every principal saves `none`;
 *  - forms: the name of a form that has submissions but no entry yet is
 *    suggested for the new entry (in words, with its count, and in the
 *    input's datalist); once it is an entry it is no longer suggested.
 */

interface Created {
  app_id: string;
  slug: string;
  workspace: string;
}

async function createApp(mcp: McpClient, name: string): Promise<Created> {
  const r = await callTool(mcp.client, 'create_app', { name, template: 'html' });
  expect(r.isError, r.text).toBe(false);
  return { app_id: r.json.app_id as string, slug: r.json.slug as string, workspace: r.json.workspace as string };
}

function modulePath(app: Created, module: string): string {
  return `/workspaces/${app.workspace}/apps/${app.slug}/modules/${module}`;
}

async function moduleConfig(mcp: McpClient, app: Created, module: string): Promise<Record<string, unknown>> {
  const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
  expect(got.isError, got.text).toBe(false);
  return (got.json.modules as Record<string, { config: Record<string, unknown> }>)[module].config;
}

async function submitForm(app: Created, form: string, data: Record<string, unknown>): Promise<void> {
  const host = previewHost(app.slug);
  const token = await hostRequest(host, `/__drobek/v1/forms/${form}/token`);
  expect(token.status, token.body).toBe(200);
  await new Promise((r) => setTimeout(r, 2_100));
  const sent = await hostRequest(host, `/__drobek/v1/forms/${form}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: urlOf(host), 'X-Drobek-SDK': '1' },
    body: JSON.stringify({ _t: (JSON.parse(token.body) as { token: string }).token, ...data }),
  });
  expect(sent.status, sent.body).toBe(200);
}

test('the files form keeps an untouched rule and an odd byte size exactly; nothing checked saves none @local', async ({ page, request }) => {
  skipUnlessLocal();
  const mcp = await mcpClient(page, request, { tag: 'files-form' });
  try {
    const app = await createApp(mcp, 'Files Settings E2E');
    const configured = await callTool(mcp.client, 'configure_module', {
      app_id: app.app_id,
      module: 'files',
      config: { rules: { upload: 'admin|user', read: 'user' }, maxBytes: 5_000_000 },
    });
    expect(configured.isError, configured.text).toBe(false);
    expect(await moduleConfig(mcp, app, 'files')).toMatchObject({ rules: { upload: 'admin|user', read: 'user' }, maxBytes: 5_000_000 });

    await page.goto(modulePath(app, 'files'));
    const form = page.getByTestId('config-form');
    await expect(form.getByTestId('rule-rules-upload-user')).toBeChecked();
    await expect(form.getByTestId('rule-rules-upload-admin')).toBeChecked();
    await expect(form.getByTestId('rule-rules-upload-public')).not.toBeChecked();
    await expect(form.getByTestId('rule-rules-read-user')).toBeChecked();
    await form.getByTestId('rule-rules-read-user').uncheck();
    for (const p of ['public', 'user', 'owner', 'admin']) await expect(form.getByTestId(`rule-rules-read-${p}`)).not.toBeChecked();
    await page.getByTestId('config-save').click();
    await expect(page.getByTestId('done-notice')).toHaveAttribute('data-done', 'applied');

    const files = await moduleConfig(mcp, app, 'files');
    expect(files.rules).toEqual({ upload: 'admin|user', read: 'none' });
    expect(files.maxBytes).toBe(5_000_000);
    await expect(page.getByTestId('rule-rules-read-user')).not.toBeChecked();
    await expect(page.getByTestId('rule-rules-upload-admin')).toBeChecked();
  } finally {
    await mcp.client.close();
  }
});

test('the forms form suggests the name of a form with submissions for a new entry, until it is one @local', async ({ page, request }) => {
  skipUnlessLocal();
  const mcp = await mcpClient(page, request, { tag: 'forms-names' });
  try {
    const app = await createApp(mcp, 'Forms Names E2E');
    await submitForm(app, 'feedback', { message: 'The new menu is great' });

    await page.goto(modulePath(app, 'forms'));
    const fresh = page.getByTestId('entry-new-forms');
    await expect(fresh.getByTestId('entry-suggested-forms')).toHaveText('Suggested: feedback (1 submission).');
    const names = page.getByTestId('entry-names-forms');
    await expect(names.locator('option')).toHaveCount(1);
    await expect(names.locator('option')).toHaveAttribute('value', 'feedback');
    const key = fresh.locator('input[name="cfg.forms[0].$key"]');
    await expect(key).toHaveAttribute('list', (await names.getAttribute('id')) as string);

    await key.fill('feedback');
    await page.getByTestId('config-save').click();
    await expect(page.getByTestId('done-notice')).toHaveAttribute('data-done', 'applied');
    expect((await moduleConfig(mcp, app, 'forms')).forms).toMatchObject({ feedback: { rules: { submit: 'public' } } });

    await page.goto(modulePath(app, 'forms'));
    await expect(page.getByTestId('entry-key-forms-0')).toHaveValue('feedback');
    await expect(page.getByTestId('entry-new-forms')).toBeVisible();
    await expect(page.getByTestId('entry-suggested-forms')).toHaveCount(0);
    await expect(page.getByTestId('entry-names-forms')).toHaveCount(0);
  } finally {
    await mcp.client.close();
  }
});
