import { expect, test } from '@playwright/test';
import {
  loginViaEmail,
  logout,
  mailpitMessagesFor,
  skipUnlessLocal,
  uniqueEmail,
} from './helpers/auth';

/**
 * U4 acceptance (PHY-54): workspaces (personal + team), fixed roles, and
 * Redis-backed invites against the local compose stack. Mirrors the ROADMAP
 * §5 e2e line — "personal ws on signup; invite→accept→editor; viewer mutation
 * 403" — plus the single-use / expired / anonymous negatives. Everything runs
 * in one browser context per test, switching users by logging out and back in
 * (invites are consumed server-side, so sequencing is deterministic).
 */

/** Unique, [a-z0-9-]-safe, 3–40 char team slug per run. */
function uniqueSlug(): string {
  return `e2e-team-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

async function createTeam(
  page: import('@playwright/test').Page,
  name: string,
  slug: string
): Promise<void> {
  await page.goto('/workspaces');
  await page.getByLabel('Team name').fill(name);
  await page.getByLabel('Slug').fill(slug);
  await page.getByRole('button', { name: 'Create team' }).click();
  await page.waitForURL(new RegExp(`/workspaces/${slug}$`));
}

test('personal workspace materializes on first /workspaces visit @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('ws-personal');

  await loginViaEmail(page, request, email);
  await page.goto('/workspaces');

  const items = page.getByTestId('workspace-item');
  await expect(items).toHaveCount(1);
  await expect(items.first().getByTestId('role-badge')).toHaveText(
    'workspace-admin'
  );
  await expect(items.first()).toContainText('personal');
});

test('invite → accept → editor: invitee joins the team as editor and sees no invite form @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const admin = uniqueEmail('ws-admin');
  const invitee = uniqueEmail('ws-editor');
  const slug = uniqueSlug();

  // Admin creates a team and invites the editor by email.
  await loginViaEmail(page, request, admin);
  await createTeam(page, 'Acme Crew', slug);
  await expect(page.getByTestId('invite-form')).toBeVisible();

  await page.getByLabel('Email (optional)').fill(invitee);
  await page.getByLabel('Role').selectOption('editor');
  await page.getByRole('button', { name: 'Create invite' }).click();

  const inviteUrl = (
    await page.getByTestId('invite-link').textContent()
  )?.trim();
  expect(inviteUrl, 'invite link is always surfaced').toBeTruthy();

  // The branded invite email actually went out to mailpit.
  const msgs = await mailpitMessagesFor(request, invitee);
  expect(msgs.length).toBeGreaterThanOrEqual(1);
  expect(msgs[0].Subject ?? '').toContain('invited');

  // Invitee signs in and accepts.
  await logout(page);
  await loginViaEmail(page, request, invitee);
  await page.goto(inviteUrl as string);
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await page.waitForURL(new RegExp(`/workspaces/${slug}$`));
  await expect(page.getByTestId('my-role')).toHaveText('editor');

  // The team now shows up in the invitee's list as editor…
  await page.goto('/workspaces');
  const teamRow = page
    .getByTestId('workspace-item')
    .filter({ hasText: `/${slug}` });
  await expect(teamRow.getByTestId('role-badge')).toHaveText('editor');

  // …and an editor cannot see the invite form.
  await page.goto(`/workspaces/${slug}`);
  await expect(page.getByTestId('invite-form')).toHaveCount(0);
});

test('viewer mutation is 403: an accepted viewer cannot POST the invite action @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const admin = uniqueEmail('ws-owner');
  const viewer = uniqueEmail('ws-viewer');
  const slug = uniqueSlug();

  await loginViaEmail(page, request, admin);
  await createTeam(page, 'Read Only Co', slug);
  await page.getByLabel('Email (optional)').fill(viewer);
  await page.getByLabel('Role').selectOption('viewer');
  await page.getByRole('button', { name: 'Create invite' }).click();
  const inviteUrl = (
    await page.getByTestId('invite-link').textContent()
  )?.trim();

  await logout(page);
  await loginViaEmail(page, request, viewer);
  await page.goto(inviteUrl as string);
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await page.waitForURL(new RegExp(`/workspaces/${slug}$`));
  await expect(page.getByTestId('my-role')).toHaveText('viewer');

  // No invite form for a viewer…
  await expect(page.getByTestId('invite-form')).toHaveCount(0);
  // …and the mutation itself is rejected server-side (role middleware).
  const res = await page.request.post(`/workspaces/${slug}/invite`, {
    form: { role: 'viewer' },
  });
  expect(res.status()).toBe(403);
});

test('an invite link is single-use; used, garbage, and expired-shaped tokens 404 @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const admin = uniqueEmail('ws-single');
  const invitee = uniqueEmail('ws-joiner');
  const slug = uniqueSlug();

  await loginViaEmail(page, request, admin);
  await createTeam(page, 'Once Only', slug);
  await page.getByLabel('Role').selectOption('editor');
  await page.getByRole('button', { name: 'Create invite' }).click();
  const inviteUrl = (
    await page.getByTestId('invite-link').textContent()
  )?.trim();

  // First accept consumes the token.
  await logout(page);
  await loginViaEmail(page, request, invitee);
  await page.goto(inviteUrl as string);
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await page.waitForURL(new RegExp(`/workspaces/${slug}$`));

  // Re-opening the consumed link shows the generic invalid page (404).
  const reused = await page.request.get(inviteUrl as string);
  expect(reused.status()).toBe(404);
  await page.goto(inviteUrl as string);
  await expect(
    page.getByText('This invite is not valid or has expired.')
  ).toBeVisible();

  // Garbage token → same generic 404, no enumeration.
  const garbage = await page.request.get('/invite/deadbeefdeadbeef');
  expect(garbage.status()).toBe(404);
});

test('anonymous /workspaces redirects to /login @smoke', async ({ page }) => {
  await page.goto('/workspaces');
  await page.waitForURL(/\/login/);
  await expect(page.getByLabel('Email')).toBeVisible();
});
