/**
 * Personal workspace ensure (U4, PHY-54) — LAZY, no backfill migration.
 * Called (1) after a successful login via the wrapped auth route modules
 * (routes/login.verify.server.ts + routes/auth.google.callback.server.ts) and
 * (2) on every /workspaces load, so existing prod users get theirs on the
 * next visit.
 *
 * "The user's personal workspace" = the kind=personal workspace where the
 * user holds a workspace-admin membership (invites are team-only, see
 * invites.server.ts, so nobody else's personal workspace can ever match).
 * Concurrency: the users row is taken FOR UPDATE inside a transaction — two
 * simultaneous first logins serialize instead of creating two workspaces.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  getSessionUser,
  logger,
  serializeError,
  SESSION_COOKIE,
} from '@drobek/auth';
import { getDb, memberships, workspaces } from '@drobek/db';
import { personalSlugBase, personalSlugCandidate } from './slug.js';
import type { WorkspaceSummary } from './membership.server.js';

const MAX_SLUG_ATTEMPTS = 20;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}

async function findPersonalWorkspace(
  db: Pick<ReturnType<typeof getDb>, 'select'>,
  userId: string
): Promise<WorkspaceSummary | null> {
  const rows = await db
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      kind: workspaces.kind,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.role, 'workspace-admin'),
        eq(workspaces.kind, 'personal')
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Idempotent: returns the existing personal workspace when there is one,
 * otherwise creates workspace (kind=personal, name "Personal", slug from the
 * sanitized email local-part with a numeric suffix on collision) + a
 * workspace-admin membership.
 */
export async function ensurePersonalWorkspace(
  userId: string,
  email: string
): Promise<WorkspaceSummary> {
  const db = getDb();

  // Fast path, no transaction.
  const existing = await findPersonalWorkspace(db, userId);
  if (existing) return existing;

  const base = personalSlugBase(email);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = personalSlugCandidate(base, attempt);
    try {
      return await db.transaction(async (tx) => {
        // Per-user mutex: concurrent ensures for the SAME user queue here.
        await tx.execute(
          sql`select id from users where id = ${userId} for update`
        );
        const again = await findPersonalWorkspace(tx, userId);
        if (again) return again;

        const [ws] = await tx
          .insert(workspaces)
          .values({ kind: 'personal', slug, name: 'Personal' })
          .returning({
            id: workspaces.id,
            slug: workspaces.slug,
            name: workspaces.name,
            kind: workspaces.kind,
          });
        await tx.insert(memberships).values({
          userId,
          workspaceId: ws.id,
          role: 'workspace-admin',
        });
        return ws;
      });
    } catch (err) {
      // Slug taken by an UNRELATED workspace — retry with the next suffix.
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }

  throw new Error('could not allocate a personal workspace slug');
}

/**
 * Post-login hook, DOCUMENTED CHOICE (U4 deliverable 2): instead of adding a
 * hook registry inside @drobek/auth (whose registration timing is
 * non-deterministic under lazy dev-server module loading), the tenancy
 * package WRAPS the two auth route modules that mint sessions
 * (login.verify action, google callback loader) and apps re-export the
 * wrapped versions. The wrapper hands the auth response to this helper: it
 * reads the freshly set session cookie, resolves it through the PUBLIC auth
 * API (getSessionUser), and ensures the personal workspace. @drobek/auth
 * internals stay untouched. Never throws — a workspace hiccup must not break
 * login (the /workspaces loader ensures again anyway).
 */
export async function ensurePersonalWorkspaceAfterLogin(
  response: unknown
): Promise<void> {
  try {
    if (!(response instanceof Response)) return;
    const pair = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]?.trim() ?? '')
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.endsWith('='));
    if (!pair) return;

    // Resolve the session through auth's public API — no key-format coupling.
    const probe = new Request('http://tenancy.internal/', {
      headers: { Cookie: pair },
    });
    const user = await getSessionUser(probe);
    if (!user) return;

    await ensurePersonalWorkspace(user.id, user.email);
  } catch (err) {
    logger.warn('[tenancy] post-login personal-workspace ensure failed', {
      err: serializeError(err),
    });
  }
}
