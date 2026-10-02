/**
 * The owners' takedown / restore e-mail: the workspace's editors and
 * workspace-admins (never a viewer), the reason category only, a failed or
 * undelivered mail is counted out and never thrown.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { memberships, users, workspaces } from '@drobek/db';
import { mailOwnersAboutModeration } from './moderation-mail.server.js';
import { freshDb, type TestDb } from './test/db.js';

const ENV = { PUBLIC_APP_URL: 'https://dash.example.test' };
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let db: TestDb;
let close: () => Promise<void>;
let app: { slug: string; workspaceId: string };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'mod-team', name: 'Mod Team' }).returning();
  for (const [email, role] of [
    ['admin@x.test', 'workspace-admin'],
    ['editor@x.test', 'editor'],
    ['viewer@x.test', 'viewer'],
  ] as const) {
    const [u] = await db.insert(users).values({ email }).returning();
    await db.insert(memberships).values({ userId: u.id, workspaceId: w.id, role });
  }
  app = { slug: 'shady-page', workspaceId: w.id };
});
afterAll(async () => close());

type Mail = { to: string; subject: string; text: string; html: string };

describe('mailOwnersAboutModeration', () => {
  it('a takedown tells the editors and admins the category and what happens next', async () => {
    const sent: Mail[] = [];
    const n = await mailOwnersAboutModeration({ kind: 'takedown', app, reason: 'phishing' }, log, ENV, async (m) => (sent.push(m), true));
    expect(n).toBe(2);
    expect(sent.map((m) => m.to).sort()).toEqual(['admin@x.test', 'editor@x.test']);
    expect(sent[0].subject).toBe('Your app shady-page was taken down');
    expect(sent[0].text).toContain('Reason: Phishing');
    expect(sent[0].text).toContain('until the operator restores it');
  });

  it('a restore says the app stays unpublished', async () => {
    const sent: Mail[] = [];
    await mailOwnersAboutModeration({ kind: 'restore', app, reason: 'phishing' }, log, ENV, async (m) => (sent.push(m), true));
    expect(sent[0].subject).toBe('Your app shady-page was restored');
    expect(sent[0].text).toContain('It is NOT published');
  });

  it('an undelivered or failing mail is not counted and never throws', async () => {
    expect(await mailOwnersAboutModeration({ kind: 'takedown', app, reason: 'spam' }, log, ENV, async () => false)).toBe(0);
    const failing = async (): Promise<boolean> => {
      throw new Error('smtp down');
    };
    expect(await mailOwnersAboutModeration({ kind: 'takedown', app, reason: 'spam' }, log, ENV, failing)).toBe(0);
    expect(log.error).toHaveBeenCalled();
    expect(await mailOwnersAboutModeration({ kind: 'takedown', app: { slug: 'x', workspaceId: 'missing' }, reason: 'spam' }, log, ENV, failing)).toBe(0);
  });
});
