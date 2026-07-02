import { expect, test, type APIRequestContext } from '@playwright/test';
import { TEST_ENV } from '../../playwright.config';

/**
 * Shared helpers for the auth specs (U2 auth-flow + U3 auth-google) — mailpit
 * polling, unique test addresses, @local gating. Not a spec file: Playwright's
 * testMatch never collects it.
 */

export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

export function skipUnlessLocal(): void {
  test.skip(
    TEST_ENV !== 'local',
    'requires TEST_ENV=local (local compose stack + mailpit)'
  );
}

/** Unique self-cleaning address per run — never collides across reruns. */
export function uniqueEmail(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

interface MailpitAddress {
  Address?: string;
}
export interface MailpitMessageMeta {
  ID: string;
  Subject?: string;
  To?: MailpitAddress[];
}

export async function mailpitMessagesFor(
  request: APIRequestContext,
  email: string
): Promise<MailpitMessageMeta[]> {
  const res = await request.get(`${MAILPIT_URL}/api/v1/messages?limit=200`);
  expect(res.ok(), 'mailpit REST API must be reachable').toBeTruthy();
  const body = (await res.json()) as { messages?: MailpitMessageMeta[] };
  return (body.messages ?? []).filter((m) =>
    (m.To ?? []).some((t) => t.Address?.toLowerCase() === email)
  );
}

export async function pollLoginCode(
  request: APIRequestContext,
  email: string,
  timeoutMs = 30_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await mailpitMessagesFor(request, email);
    if (msgs.length > 0) {
      const detail = await request.get(
        `${MAILPIT_URL}/api/v1/message/${msgs[0].ID}`
      );
      if (detail.ok()) {
        const d = (await detail.json()) as { Subject?: string; Text?: string };
        const m = /\b(\d{6})\b/.exec(`${d.Subject ?? ''}\n${d.Text ?? ''}`);
        if (m) return m[1];
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no login-code email for ${email} within ${timeoutMs}ms`);
}
