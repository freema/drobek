import { expect, test } from '@playwright/test';
import { loginViaEmail, logout, skipUnlessLocal, uniqueEmail } from './helpers/auth';

/**
 * Workspace orientation and the account onboarding (NSO-371 review): two
 * workspaces named "Personal" are told apart by slug and owner, the access
 * badge says where access comes from (a membership or the super-admin
 * override), the header's switcher reaches the account and your own
 * workspaces, and /me connects an agent with copyable snippets, names the
 * default workspace and hands an empty workspace a first prompt.
 */

const SUPER_ADMIN = 'e2e-superadmin@drobek.test';

async function personalSlug(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/me');
  const text = (await page.getByTestId('me-default-workspace').textContent()) ?? '';
  return text.trim().replace(/^\//, '');
}

test('a super-admin in another user’s personal workspace sees slug, owner and superadmin access @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const jana = uniqueEmail('orient-owner');
  await loginViaEmail(page, request, jana);
  const janaSlug = await personalSlug(page);
  await page.goto(`/workspaces/${janaSlug}/apps`);
  await expect(page.getByTestId('my-role')).toHaveText('workspace-admin');
  await expect(page.getByTestId('my-role')).toHaveAttribute('data-role-source', 'member');
  await expect(page.getByTestId('workspace-access-note')).toHaveCount(0);
  await logout(page);

  await loginViaEmail(page, request, SUPER_ADMIN);
  const ownSlug = await personalSlug(page);
  expect(ownSlug).not.toBe(janaSlug);

  await page.goto(`/workspaces/${janaSlug}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Personal');
  await expect(page.getByTestId('workspace-slug')).toHaveText(`/${janaSlug}`);
  await expect(page.getByTestId('my-role')).toHaveText('Superadmin access — not a member');
  await expect(page.getByTestId('my-role')).toHaveAttribute('data-role-source', 'superadmin');
  await expect(page.getByTestId('workspace-owner')).toHaveText(jana);

  // The switcher lists the super-admin's own workspaces and the account.
  await page.getByTestId('workspace-switcher').locator('summary').click();
  await expect(page.locator(`[data-testid="switch-workspace"][data-slug="${janaSlug}"]`)).toHaveCount(0);
  await page.locator(`[data-testid="switch-workspace"][data-slug="${ownSlug}"]`).click();
  await page.waitForURL(new RegExp(`/workspaces/${ownSlug}/apps$`));
  await expect(page.getByTestId('workspace-slug')).toHaveText(`/${ownSlug}`);
  await expect(page.getByTestId('my-role')).toHaveText('workspace-admin');

  // The all-workspaces list names the owner and the source of access.
  await page.goto('/workspaces');
  await page.getByTestId('all-workspaces-filter').fill(janaSlug);
  const row = page.locator(`[data-testid="all-workspace-item"][data-slug="${janaSlug}"]`);
  await expect(row.getByTestId('workspace-owner')).toContainText(jana);
  await expect(row.getByTestId('all-workspace-access')).toHaveText('Superadmin access — not a member');
});

test('/me: copy the MCP URL, pick a client, and get a first prompt for the empty default workspace @local', async ({
  page,
  request,
  context,
}) => {
  skipUnlessLocal();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await loginViaEmail(page, request, uniqueEmail('orient-me'));
  await page.goto('/me');

  const mcpUrl = (await page.getByTestId('me-mcp-url').textContent())?.trim() ?? '';
  expect(mcpUrl).toMatch(/^https?:\/\/.+\/mcp$/);
  await page.getByTestId('me-mcp-url-copy').click();
  await expect(page.getByTestId('me-mcp-url-copy-status')).toHaveText('MCP URL copied to the clipboard.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(mcpUrl);

  // The picker: every client documented in the agent guide, snippets with this server's URL.
  await expect(page.getByTestId('me-client')).toHaveText(['Claude Code', 'Claude (web and desktop)', 'Cursor', 'Codex']);
  await expect(page.getByTestId('me-client-steps')).toContainText(`claude mcp add --transport http drobek ${mcpUrl}`);
  await page.locator('[data-testid="me-client"][data-client="cursor"]').click();
  await expect(page.locator('[data-testid="me-client"][data-client="cursor"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('me-client-steps')).toContainText('~/.cursor/mcp.json');
  await expect(page.getByTestId('me-client-steps')).toContainText(`"url": "${mcpUrl}"`);

  // A new account's personal workspace is empty: the first prompt names it.
  const slug = ((await page.getByTestId('me-default-workspace').textContent()) ?? '').trim().replace(/^\//, '');
  await expect(page.getByTestId('me-first-prompt')).toContainText(`"${slug}"`);
  await expect(page.locator(`[data-testid="me-workspace"][data-slug="${slug}"]`)).toContainText('your agent’s default');
});

test('/me: a refused clipboard says so and selects the text @local', async ({ page, request }) => {
  skipUnlessLocal();
  await loginViaEmail(page, request, uniqueEmail('orient-noclip'));
  await page.goto('/me');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
    });
  });
  await page.getByTestId('me-mcp-url-copy').click();
  await expect(page.getByTestId('me-mcp-url-copy-status')).toContainText('Your browser did not allow copying');
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toMatch(/\/mcp$/);
});

test('/me/connections explains OAuth clients and points to API keys @local', async ({ page, request }) => {
  skipUnlessLocal();
  await loginViaEmail(page, request, uniqueEmail('orient-conn'));
  await page.goto('/me/connections');
  await expect(page.getByTestId('connections-empty')).toContainText('No approved OAuth clients');
  const keys = page.getByTestId('connections-api-keys');
  await expect(keys).toContainText('You have no active API keys.');
  await keys.getByRole('link', { name: 'Manage API keys' }).click();
  await page.waitForURL(/\/me\/api-keys$/);
});
