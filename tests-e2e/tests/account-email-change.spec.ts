import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { MAILPIT_URL, loginViaEmail, mailpitMessagesFor, pollLoginCode, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { callTool, mcpClient, rawInitialize } from './helpers/mcp';
import { userIdByEmail, withDb } from './helpers/seed';

/**
 * Changing the sign-in e-mail on /me against the local compose stack and
 * Mailpit:
 *   (1) an address another account signs in with: the page answers as for
 *       any address, that mailbox gets an "already has an account" e-mail
 *       without a code, and no code changes anything;
 *   (2) a fresh address: the code from its mailbox changes the address, the
 *       previous address gets a notice, the other session ends while this
 *       browser stays signed in, the API key and the OAuth connection keep
 *       working, and the change is audited;
 *   (3) the new address signs in to the same account.
 */

async function signedInPage(browser: Browser, request: APIRequestContext, email: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginViaEmail(page, request, email);
  return page;
}

async function seenIds(request: APIRequestContext, email: string): Promise<Set<string>> {
  return new Set((await mailpitMessagesFor(request, email)).map((m) => m.ID));
}

/** The newest message to `email` with `subject` that is not in `seen` → its text (CRLF normalized). */
async function pollMail(request: APIRequestContext, email: string, subject: string, seen: ReadonlySet<string>): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const hit = (await mailpitMessagesFor(request, email)).find((m) => !seen.has(m.ID) && m.Subject === subject);
    if (hit) {
      const detail = await request.get(`${MAILPIT_URL}/api/v1/message/${hit.ID}`);
      if (detail.ok()) return ((await detail.json()) as { Text?: string }).Text?.replace(/\r\n/g, '\n') ?? '';
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no "${subject}" e-mail for ${email} within 30 s`);
}

async function emailOf(userId: string): Promise<string | undefined> {
  return withDb(async (c) => (await c.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0]?.email as string | undefined);
}

test('changing the sign-in e-mail: a code to the new address, a taken address looks the same, other sessions end, keys and connections stay @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  const owner = await mcpClient(page, request, { tag: 'email-change' });
  const ownerId = await userIdByEmail(owner.email);
  const holderEmail = uniqueEmail('email-change-holder');
  await (await signedInPage(browser, request, holderEmail)).context().close();
  const second = await signedInPage(browser, request, owner.email);
  const next = uniqueEmail('email-change-next');
  let fresh: Page | null = null;
  try {
    await page.goto('/me/api-keys');
    await page.getByTestId('api-key-name').fill('e2e email change key');
    await page.getByTestId('api-key-create').click();
    const key = ((await page.getByTestId('api-key-value').textContent()) ?? '').trim();
    expect(key).toMatch(/^drk_/);

    await page.goto('/me');
    await expect(page.getByTestId('me-email')).toContainText(`You sign in with ${owner.email}`);

    // (1) An address another account signs in with: the same answer, a notice instead of a code.
    const holderSeen = await seenIds(request, holderEmail);
    await page.getByTestId('me-email-new').fill(holderEmail.toUpperCase());
    await page.getByTestId('me-email-send-code').click();
    await expect(page.getByTestId('me-email-code-sent')).toContainText(`We e-mailed a 6-digit code to ${holderEmail}.`);
    const inUse = await pollMail(request, holderEmail, 'drobek — this address already has an account', holderSeen);
    expect(inUse).toContain('nothing changed and no code was sent');
    expect(inUse).not.toMatch(/\b\d{6}\b/);
    await page.getByTestId('me-email-code').fill('000000');
    await page.getByTestId('me-email-confirm').click();
    await expect(page.getByTestId('me-email-error')).toContainText('That code is not valid');
    expect(await emailOf(ownerId)).toBe(owner.email);

    // (2) A fresh address: its code changes the address.
    await page.getByTestId('me-email-cancel').click();
    await expect(page.getByTestId('me-email-new')).toBeVisible();
    await page.getByTestId('me-email-new').fill(next);
    await page.getByTestId('me-email-send-code').click();
    await expect(page.getByTestId('me-email-code-sent')).toContainText(`We e-mailed a 6-digit code to ${next}.`);
    const code = await pollLoginCode(request, next);
    const oldSeen = await seenIds(request, owner.email);

    await page.getByTestId('me-email-code').fill(code === '000000' ? '111111' : '000000');
    await page.getByTestId('me-email-confirm').click();
    await expect(page.getByTestId('me-email-error')).toContainText('That code is not valid');
    expect(await emailOf(ownerId)).toBe(owner.email);

    await page.getByTestId('me-email-code').fill(code);
    await page.getByTestId('me-email-confirm').click();
    await page.waitForURL(/\/me\?email=changed$/);
    await expect(page.getByTestId('me-email-changed')).toContainText(`You now sign in with ${next}`);
    await expect(page.getByTestId('me-account-email')).toHaveText(next);
    expect(await emailOf(ownerId)).toBe(next);

    const notice = await pollMail(request, owner.email, 'drobek — your sign-in e-mail was changed', oldSeen);
    expect(notice).toContain(`now signs in with ${next.slice(0, 2)}***@example.com`);
    expect(notice).not.toContain(next);

    // The other session ended; this browser stays signed in; the key and the connection keep working.
    await second.goto('/me');
    await expect(second).toHaveURL(/\/login/);
    await page.goto('/me/api-keys');
    await expect(page).toHaveURL(/\/me\/api-keys$/);
    expect((await rawInitialize(request, { Authorization: `Bearer ${key}` })).status()).toBe(200);
    const listed = await callTool(owner.client, 'list_apps', {});
    expect(listed.isError, listed.text).toBe(false);

    const audit = await withDb(async (c) =>
      (await c.query(`SELECT actor_kind, actor_user_id, meta FROM audit_log WHERE action = 'account.email_change' AND target = $1`, [ownerId])).rows
    );
    expect(audit).toEqual([{ actor_kind: 'user', actor_user_id: ownerId, meta: null }]);

    // (3) The new address signs in to the same account.
    fresh = await signedInPage(browser, request, next);
    await expect(fresh.getByTestId('me-account-email')).toHaveText(next);
    await expect(fresh.getByTestId('me-default-workspace')).toHaveText(`/${owner.workspace}`);
  } finally {
    await fresh?.context().close();
    await second.context().close();
    await owner.client.close();
  }
});
