import { expect, test, type Page } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';
import { setFakePlan } from './helpers/limits';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';
import { personalWorkspaceOf } from './helpers/seed';

/**
 * The upstream caps of a workspace, over MCP and on the Upstreams page.
 *  - UPSTREAMS_MAX_PER_WORKSPACE (default 20; per workspace through the
 *    limits provider — here the fake one on proxy-echo, helpers/limits.ts):
 *    register_upstream refuses the next upstream with `limit_exceeded`
 *    naming the limit and its value — a keyed one too, before it hands out
 *    the dashboard link; the page says the workspace is full and its form
 *    refuses the same way. A lowered cap keeps the upstreams it has, and
 *    removing one always works.
 *  - UPSTREAM_REGISTRATIONS_PER_HOUR (default 20, env only): the 21st
 *    registration within the hour is `rate_limited` with
 *    `retry_after_seconds`; removing an upstream does not give the budget back.
 */

const ECHO_BASE = 'http://proxy-echo';
const REGISTRATIONS_PER_HOUR = 20;

function register(mcp: McpClient, name: string, extra: Record<string, unknown> = {}) {
  return callTool(mcp.client, 'register_upstream', {
    workspace: mcp.workspace,
    name,
    base_url: ECHO_BASE,
    allowed_methods: ['GET'],
    allowed_path_prefixes: ['/echo'],
    auth_type: 'none',
    ...extra,
  });
}

async function listedNames(mcp: McpClient): Promise<string[]> {
  const list = await callTool(mcp.client, 'list_upstreams', { workspace: mcp.workspace });
  expect(list.isError, list.text).toBe(false);
  return (list.json.upstreams as { name: string }[]).map((u) => u.name).sort();
}

async function submitForm(page: Page, ws: string, name: string): Promise<void> {
  await page.goto(`/workspaces/${ws}/upstreams`);
  await page.getByTestId('field-name').fill(name);
  await page.getByTestId('field-baseurl').fill(ECHO_BASE);
  await page.getByTestId('field-methods').fill('GET');
  await page.getByTestId('field-paths').fill('/echo');
  await page.getByTestId('upstream-submit').click();
}

test('UPSTREAMS_MAX_PER_WORKSPACE: the next upstream is limit_exceeded over MCP and in the form; a lowered cap keeps what is there; remove always works @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  test.setTimeout(120_000);
  const mcp = await mcpClient(page, request, { tag: 'upstream-cap' });
  const ws = await personalWorkspaceOf(mcp.email);
  await setFakePlan(ws.id, { UPSTREAMS_MAX_PER_WORKSPACE: 2 });
  try {
    for (const name of ['echo-a', 'echo-b']) {
      const ok = await register(mcp, name);
      expect(ok.isError, ok.text).toBe(false);
      expect(ok.json).toMatchObject({ registered: true, upstream: { name } });
    }

    const third = await register(mcp, 'echo-c');
    expect(third.isError).toBe(true);
    expect(third.json).toMatchObject({ code: 'limit_exceeded', limit: 'UPSTREAMS_MAX_PER_WORKSPACE', value: 2 });
    expect(String(third.json.message)).toContain('This workspace already has 2 upstreams; its limit (UPSTREAMS_MAX_PER_WORKSPACE) is 2.');

    // A keyed upstream is refused before register_upstream hands out the dashboard link.
    const keyed = await register(mcp, 'echo-keyed', { auth_type: 'bearer' });
    expect(keyed.isError).toBe(true);
    expect(keyed.json).toMatchObject({ code: 'limit_exceeded', limit: 'UPSTREAMS_MAX_PER_WORKSPACE', value: 2 });
    expect(keyed.json.secret_url).toBeUndefined();
    expect(await listedNames(mcp)).toEqual(['echo-a', 'echo-b']);

    await page.goto(`/workspaces/${mcp.workspace}/upstreams`);
    const hint = page.getByTestId('upstreams-limit');
    await expect(hint).toHaveAttribute('data-full', 'true');
    await expect(hint).toContainText('This workspace has 2 of its 2 upstreams. Delete one the apps no longer need before you register another.');
    await submitForm(page, mcp.workspace, 'echo-form');
    const error = page.getByTestId('upstream-error');
    await expect(error).toHaveAttribute('data-error-code', 'limit_exceeded');
    await expect(error).toContainText('its limit (UPSTREAMS_MAX_PER_WORKSPACE) is 2');
    await expect(page.locator('[data-testid="upstream-row"][data-upstream-name="echo-form"]')).toHaveCount(0);

    // A lowered cap keeps both; the next one is refused at the new value.
    await setFakePlan(ws.id, { UPSTREAMS_MAX_PER_WORKSPACE: 1 });
    expect(await listedNames(mcp)).toEqual(['echo-a', 'echo-b']);
    const over = await register(mcp, 'echo-c');
    expect(over.json).toMatchObject({ code: 'limit_exceeded', limit: 'UPSTREAMS_MAX_PER_WORKSPACE', value: 1 });
    await page.goto(`/workspaces/${mcp.workspace}/upstreams`);
    await expect(page.getByTestId('upstreams-limit')).toContainText('This workspace has 2 of its 1 upstreams.');
    await expect(page.locator('[data-testid="upstream-row"]')).toHaveCount(2);

    // Removing works over the cap; registering again only once there is room.
    const unconfirmed = await callTool(mcp.client, 'remove_upstream', { workspace: mcp.workspace, name: 'echo-a' });
    expect(unconfirmed.json.code).toBe('user_confirmation_required');
    const removedA = await callTool(mcp.client, 'remove_upstream', { workspace: mcp.workspace, name: 'echo-a', user_confirmed: true });
    expect(removedA.isError, removedA.text).toBe(false);
    expect(removedA.json.removed).toBe('echo-a');
    expect((await register(mcp, 'echo-c')).json).toMatchObject({ code: 'limit_exceeded', value: 1 });
    const removedB = await callTool(mcp.client, 'remove_upstream', { workspace: mcp.workspace, name: 'echo-b', user_confirmed: true });
    expect(removedB.isError, removedB.text).toBe(false);
    expect(await listedNames(mcp)).toEqual([]);
    const again = await register(mcp, 'echo-c');
    expect(again.isError, again.text).toBe(false);
    await page.goto(`/workspaces/${mcp.workspace}/upstreams`);
    await expect(page.getByTestId('upstreams-limit')).toHaveAttribute('data-full', 'true');
    await expect(page.getByTestId('upstreams-limit')).toContainText('This workspace has 1 of its 1 upstreams.');
  } finally {
    await setFakePlan(ws.id, null);
    await mcp.client.close();
  }
});

test('UPSTREAM_REGISTRATIONS_PER_HOUR: the 21st registration within the hour is rate_limited with retry_after_seconds; a removal does not give it back @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  test.setTimeout(120_000);
  const mcp = await mcpClient(page, request, { tag: 'upstream-rate' });
  const ws = await personalWorkspaceOf(mcp.email);
  // Room for more than the hourly budget, so only the rate can refuse.
  await setFakePlan(ws.id, { UPSTREAMS_MAX_PER_WORKSPACE: REGISTRATIONS_PER_HOUR + 5 });
  try {
    for (let i = 0; i < REGISTRATIONS_PER_HOUR; i++) {
      const ok = await register(mcp, `echo-${i}`);
      expect(ok.isError, `registration ${i + 1}: ${ok.text}`).toBe(false);
    }

    const limited = await register(mcp, 'echo-over');
    expect(limited.isError).toBe(true);
    expect(limited.json).toMatchObject({ code: 'rate_limited', limit: 'UPSTREAM_REGISTRATIONS_PER_HOUR', value: REGISTRATIONS_PER_HOUR });
    expect(limited.json.retry_after_seconds).toBeGreaterThan(3_400);
    expect(limited.json.retry_after_seconds).toBeLessThanOrEqual(3_600);
    expect(String(limited.json.message)).toContain(
      `registered ${REGISTRATIONS_PER_HOUR} upstreams within the last hour; its limit (UPSTREAM_REGISTRATIONS_PER_HOUR) is ${REGISTRATIONS_PER_HOUR}.`
    );

    const keyed = await register(mcp, 'echo-keyed', { auth_type: 'bearer' });
    expect(keyed.json).toMatchObject({ code: 'rate_limited', limit: 'UPSTREAM_REGISTRATIONS_PER_HOUR' });
    expect(keyed.json.secret_url).toBeUndefined();

    const removed = await callTool(mcp.client, 'remove_upstream', { workspace: mcp.workspace, name: 'echo-0', user_confirmed: true });
    expect(removed.isError, removed.text).toBe(false);
    expect((await register(mcp, 'echo-0')).json).toMatchObject({ code: 'rate_limited', limit: 'UPSTREAM_REGISTRATIONS_PER_HOUR' });

    await submitForm(page, mcp.workspace, 'echo-form');
    await expect(page.getByTestId('upstream-error')).toHaveAttribute('data-error-code', 'rate_limited');
    expect(await listedNames(mcp)).toHaveLength(REGISTRATIONS_PER_HOUR - 1);
  } finally {
    await setFakePlan(ws.id, null);
    await mcp.client.close();
  }
});
