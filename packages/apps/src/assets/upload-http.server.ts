/**
 * The upload URL endpoint (NSO-358): `/api/assets/upload/<token>` on the
 * DASHBOARD host (never an app host), mounted by apps/server before React
 * Router. Typed on node:http only, so Express req/res fit.
 *
 *   PUT  the bytes (curl -T, or the page below). The token is the only
 *        credential: it is taken (single use) before a byte is read; the
 *        user it was issued for must STILL be an editor of the app's
 *        workspace (or a super-admin) — a member removed or demoted since
 *        cannot complete an upload with an earlier link (403 forbidden,
 *        NSO-362). Then the body streams through storeAsset (size, type,
 *        quota, audit as that user) into the app's DRAFT assets — the
 *        production host shows it after the next publish. 201 `{ name, path,
 *        size, type, replaced }`; a refusal is `{ code, message, hint,
 *        …details }` with its status (404 upload_token_invalid, 403
 *        forbidden, 413 asset_too_large /
 *        asset_quota_exceeded, 415 asset_type_not_allowed, 400
 *        asset_size_mismatch, 423 app_locked_by_admin). A refusal sent while
 *        the body is still arriving closes the connection after the answer
 *        (closeAfterResponse) instead of reading the rest.
 *   GET  a small page with a file picker that PUTs to the same URL — for a
 *        user who got the link from an agent without a shell. It does not
 *        use the token.
 *
 * The token never reaches a log line; neither does the request URL.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { closeAfterResponse, createConsoleLogger, requestBodyStream, type Logger } from '@drobek/core';
import { and, eq, inArray } from 'drizzle-orm';
import { dbErrorForLog, getDb, memberships, users } from '@drobek/db';
import type { AssetLimits } from './config.js';
import type { AssetDisk } from './disk.server.js';
import { AssetsError } from './errors.js';
import { storeAsset } from './assets.server.js';
import { assetPath } from './names.js';
import { consumeUploadToken, peekUploadToken, redisUploadTokenStore, type UploadGrant, type UploadTokenStore } from './tokens.server.js';
import { uploadGonePage, uploadPage } from './upload-page.js';

export interface AssetUploadHandlerOptions {
  /** The limits of the app's workspace (limits provider, else the env). */
  limits: (workspaceId: string) => Promise<AssetLimits>;
  /** The catalogue hint for an error code (@drobek/agent-dx errorHint). */
  hint: (code: string) => string;
  /** Where the uploaded asset will be visible (the app's preview URL + path), for the page and the answer. */
  assetUrl?: (appSlug: string, path: string) => string | null;
  /** May the user the grant was issued for still change the app's assets? Default: uploaderMayEdit. */
  mayUpload?: (grant: UploadGrant) => Promise<boolean>;
  tokens?: UploadTokenStore;
  disk?: AssetDisk;
  log?: Logger;
  now?: () => number;
}

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Is `userId` still an editor+ of `workspaceId` — or a super-admin
 * (SUPERADMIN_EMAIL, the global flag; @drobek/auth cannot be imported here)?
 * Checked when an upload URL is USED, not only when it was issued (NSO-362).
 */
export async function uploaderMayEdit(userId: string, workspaceId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const db = getDb();
  const [member] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId), inArray(memberships.role, ['workspace-admin', 'editor'])))
    .limit(1);
  if (member) return true;
  const admins = (env.SUPERADMIN_EMAIL ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (admins.length === 0) return false;
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return user !== undefined && admins.includes(user.email.trim().toLowerCase());
}

function tokenOf(req: IncomingMessage): string {
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? '';
  // A token is base64url: no percent-encoding to undo; anything else fails its format check.
  return path.slice(path.lastIndexOf('/') + 1);
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (!req.complete) closeAfterResponse(req, res);
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function sendPage(res: ServerResponse, status: number, page: { html: string; csp: string }, head: boolean): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': page.csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  res.end(head ? undefined : page.html);
}

/** The node handler of `/api/assets/upload/<token>` (see the file header). */
export function createAssetUploadHandler(opts: AssetUploadHandlerOptions): NodeHandler {
  const tokens = opts.tokens ?? redisUploadTokenStore();
  const log = opts.log ?? createConsoleLogger('assets');
  const now = opts.now ?? Date.now;
  const mayUpload = opts.mayUpload ?? ((grant: UploadGrant) => uploaderMayEdit(grant.userId, grant.workspaceId));
  const refuse = (req: IncomingMessage, res: ServerResponse, err: AssetsError) =>
    sendJson(req, res, err.status, { code: err.code, message: err.message, hint: opts.hint(err.code), ...err.details });

  async function put(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const grant = await consumeUploadToken(tokens, tokenOf(req), now);
    if (!grant) {
      refuse(req, res, new AssetsError('upload_token_invalid', 'This upload URL is unknown, already used or expired (they work once, for 30 minutes).'));
      return;
    }
    if (!(await mayUpload(grant))) {
      refuse(req, res, new AssetsError('forbidden', 'The user this upload URL was issued for is no longer an editor of the app, so it cannot be used.'));
      return;
    }
    const declaredLength = req.headers['content-length'];
    if (declaredLength !== undefined && Number(declaredLength) !== grant.size) {
      refuse(
        req,
        res,
        new AssetsError('asset_size_mismatch', `The request body is ${declaredLength} bytes; this upload URL is for exactly ${grant.size} bytes of "${grant.name}".`, {
          declared: grant.size,
        })
      );
      return;
    }
    const limits = await opts.limits(grant.workspaceId);
    const stored = await storeAsset({
      app: { id: grant.appId, slug: grant.appSlug, workspaceId: grant.workspaceId },
      name: grant.name,
      body: requestBodyStream(req),
      size: grant.size,
      contentType: grant.contentType || (typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null),
      limits,
      actor: { userId: grant.userId, kind: grant.actorKind },
      via: grant.via,
      ...(opts.disk ? { disk: opts.disk } : {}),
    });
    const url = opts.assetUrl?.(grant.appSlug, stored.path) ?? null;
    sendJson(req, res, 201, {
      name: stored.name,
      path: stored.path,
      size: stored.size,
      type: stored.type,
      replaced: stored.replaced,
      ...(url ? { url } : {}),
    });
  }

  async function get(req: IncomingMessage, res: ServerResponse, head: boolean): Promise<void> {
    const grant = await peekUploadToken(tokens, tokenOf(req), now);
    if (!grant) {
      sendPage(res, 404, uploadGonePage(), head);
      return;
    }
    const assetUrl = opts.assetUrl?.(grant.appSlug, assetPath(grant.name)) ?? null;
    sendPage(res, 200, uploadPage({ appSlug: grant.appSlug, name: grant.name, size: grant.size, expiresAt: new Date(grant.expiresAt), assetUrl }), head);
  }

  return (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const run = method === 'PUT' ? put(req, res) : method === 'GET' || method === 'HEAD' ? get(req, res, method === 'HEAD') : null;
    if (!run) {
      res.setHeader('Allow', 'GET, HEAD, PUT');
      sendJson(req, res, 405, { code: 'method_not_allowed', message: 'Upload the file with PUT (curl -T <file> <url>).', hint: opts.hint('method_not_allowed') });
      return;
    }
    run.catch((err: unknown) => {
      if (err instanceof AssetsError) {
        refuse(req, res, err);
        return;
      }
      if (!req.complete && !req.readableEnded && req.destroyed) return; // the uploader went away mid-body
      log.error('asset upload failed', { error: dbErrorForLog(err, { stack: true }) });
      sendJson(req, res, 500, {
        code: 'internal_error',
        message: 'drobek hit an internal error while storing the upload. Ask for a new upload URL and retry once.',
        hint: opts.hint('internal_error'),
      });
    });
  };
}
