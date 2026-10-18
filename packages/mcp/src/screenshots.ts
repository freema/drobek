/**
 * A screenshot of the preview for the agent: request_screenshot asks the
 * app's open preview tabs for one (a bar with Capture / Not now, the agent's
 * note as plain text), get_screenshot reads where the request stands and,
 * once a person captured it, the image.
 *
 * request_screenshot needs editor+ and a version that compiled (the preview
 * serves it); a version whose drobek.json has `"screenshots": false` shows no
 * bar, so the request is refused (`conflict`). At most
 * SCREENSHOT_REQUESTS_PER_APP_HOUR requests per app (`rate_limited`); a
 * request waits SCREENSHOT_REQUEST_TTL_SEC for its answer.
 *
 * get_screenshot needs any role in the app's workspace (the request id names
 * the app; an unknown id and an app the caller cannot reach answer the same
 * `not_found`). The image is a person's capture of the app's own pages, so it
 * is drobek's re-encoding (JPEG within MCP_IMAGE_MAX_BYTES) between the two
 * text blocks of an untrusted envelope — it can show text.
 */
import {
  AppsError,
  getAppScreenshot,
  imageLimits,
  isScreenshotRequestId,
  lookupScreenshot,
  previewUrl,
  readVersionFile,
  reencodeForMcp,
  requestScreenshot,
  screenshotLimits,
  SCREENSHOT_RETRY_AFTER_SECONDS,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { CONFIG_FILE, previewScriptOptions } from '@drobek/compile';
import { authorizeApp } from './access.js';
import { lockedByAdmin, ToolError } from './errors.js';
import { mcpImageOf, untrustedImageContent, type McpContentBlock, type McpImage } from './image.js';
import { previewVersionHead } from './queries.js';
import type { CallContext } from './tools.js';

// ── request_screenshot ───────────────────────────────────────────────────────

export async function requestScreenshotTool(ctx: CallContext, args: { app_id: string; note?: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (app.lockedReason) throw lockedByAdmin(app.lockedReason);
  if (args.note !== undefined && args.note !== null && typeof args.note !== 'string') {
    throw new ToolError('invalid_params', '`note` must be a short text (at most 200 characters).');
  }
  const head = await previewVersionHead(app.id);
  if (!head) {
    throw new ToolError('conflict', 'No version of this app has compiled yet, so its preview has no page to capture. Fix the compile errors and write again first.');
  }
  const config = await readVersionFile(head.id, CONFIG_FILE);
  if (!previewScriptOptions(config ? config.toString('utf8') : undefined).screenshots) {
    throw new ToolError(
      'conflict',
      `drobek.json of version ${head.number} (the one the preview serves) sets "screenshots": false, so the preview shows no screenshot request. Remove it (or set it to true) with write_files if the user wants to send screenshots, or ask the user to describe what they see.`,
      { version: head.number }
    );
  }
  const limits = screenshotLimits(ctx.deps.env);
  let req: Awaited<ReturnType<typeof requestScreenshot>>;
  try {
    req = await requestScreenshot(
      { app, version: head.number, note: args.note, actor: { userId: ctx.principal.userId, kind: actorKindForSurface('mcp') } },
      { store: ctx.deps.screenshots, now: ctx.deps.now, limits, notify: ctx.deps.notifyAppChanged }
    );
  } catch (err) {
    if (err instanceof AppsError && err.code === 'invalid_settings') throw new ToolError('invalid_params', err.message);
    if (err instanceof AppsError && err.code === 'rate_limited') throw new ToolError('rate_limited', err.message, { ...err.details });
    throw err;
  }
  return {
    app_id: app.id,
    request_id: req.id,
    status: 'pending' as const,
    version: head.number,
    preview_url: previewUrl(app.slug, ctx.deps.env),
    expires_at: new Date(req.expiresAt).toISOString(),
    retry_after_seconds: SCREENSHOT_RETRY_AFTER_SECONDS,
    hint: 'ask the person to open the preview and click Capture',
    note: `Tell the user: "Open ${previewUrl(app.slug, ctx.deps.env)} on the page you want me to see and click Capture on the bar at the top." Then call get_screenshot({ request_id }) every ${SCREENSHOT_RETRY_AFTER_SECONDS} seconds or so until it is ready, declined or expired (after ${Math.round(limits.requestTtlSec / 60)} minutes).`,
  };
}

// ── get_screenshot ───────────────────────────────────────────────────────────

function noSuchRequest(id: string): ToolError {
  return new ToolError(
    'not_found',
    'There is no such screenshot request: the id is wrong, the app is not one you can reach, or the request is older than SCREENSHOTS_RETENTION_DAYS (its screenshot was removed). request_screenshot asks again.',
    { request_id: id }
  );
}

export type ScreenshotPayload =
  | { app_id: string; request_id: string; status: 'pending' | 'expired' | 'declined'; retry_after_seconds?: number; expires_at?: string; note: string }
  | {
      app_id: string;
      request_id: string;
      status: 'ready';
      version: number | null;
      page: string | null;
      browser: string | null;
      captured_at: string;
      stored: { width: number; height: number; bytes: number };
      image: McpImage;
      note: string;
    };

export async function getScreenshotTool(ctx: CallContext, args: { request_id: string }): Promise<ScreenshotPayload> {
  if (!isScreenshotRequestId(args.request_id)) {
    throw new ToolError('invalid_params', '`request_id` must be the `request_id` request_screenshot answered (ss_ followed by 24 hex digits).');
  }
  const id = args.request_id;
  const found = await lookupScreenshot(id, { store: ctx.deps.screenshots, now: ctx.deps.now });
  if (!found) throw noSuchRequest(id);
  const { app } = await authorizeApp(ctx.principal, found.appId, 'viewer').catch((err: unknown) => {
    if (err instanceof ToolError && err.code === 'not_found') throw noSuchRequest(id);
    throw err;
  });
  if (found.state === 'pending') {
    return {
      app_id: app.id,
      request_id: id,
      status: 'pending',
      retry_after_seconds: SCREENSHOT_RETRY_AFTER_SECONDS,
      expires_at: new Date(found.request.expiresAt).toISOString(),
      note: `Nobody has answered yet: the person has to open ${previewUrl(app.slug, ctx.deps.env)} and click Capture. Ask again in ${SCREENSHOT_RETRY_AFTER_SECONDS} seconds.`,
    };
  }
  if (found.state === 'declined') {
    return {
      app_id: app.id,
      request_id: id,
      status: 'declined',
      note: 'The person clicked "Not now" (or their browser cannot capture the screen). Ask the user to describe what they see; do not ask for another screenshot unless they offer one.',
    };
  }
  if (found.state === 'expired') {
    return {
      app_id: app.id,
      request_id: id,
      status: 'expired',
      note: 'Nobody answered the request in time (SCREENSHOT_REQUEST_TTL_SEC). If the user still wants to show you the page, call request_screenshot again and make sure they have the preview open.',
    };
  }
  const shot = await getAppScreenshot(app.id, id);
  if (!shot) throw noSuchRequest(id);
  const limits = imageLimits(ctx.deps.env);
  const img = await reencodeForMcp(shot.data, limits).catch((err: unknown) => {
    if (err instanceof AppsError && err.code === 'too_large') {
      throw new ToolError(
        'limit_exceeded',
        `The screenshot does not fit into MCP_IMAGE_MAX_BYTES (${limits.mcpImageMaxBytes} bytes) even when made smaller; ask the operator for a higher limit, or ask the user to describe what it shows.`,
        { limit: 'MCP_IMAGE_MAX_BYTES' }
      );
    }
    throw err;
  });
  return {
    app_id: app.id,
    request_id: id,
    status: 'ready',
    version: shot.versionNumber,
    page: shot.path,
    browser: shot.browser,
    captured_at: shot.capturedAt.toISOString(),
    stored: { width: shot.width, height: shot.height, bytes: shot.bytes },
    image: mcpImageOf(img),
    note: 'This is the preview as the person saw it when they clicked Capture. Fix what it shows if the user wants it; read_file and get_logs({ kind: "browser" }) help find the cause.',
  };
}

/** get_screenshot's content: the image in the untrusted envelope when ready, else the JSON answer. */
export function screenshotContent(p: ScreenshotPayload): McpContentBlock[] | null {
  if (p.status !== 'ready') return null;
  return untrustedImageContent({
    tag: 'untrusted-agent-screenshot',
    attrs: {
      app_id: p.app_id,
      request_id: p.request_id,
      status: p.status,
      ...(p.version !== null ? { version: p.version } : {}),
      ...(p.page !== null ? { page: encodeURI(p.page) } : {}),
      ...(p.browser !== null ? { browser: p.browser } : {}),
      captured_at: p.captured_at,
      stored_width: p.stored.width,
      stored_height: p.stored.height,
    },
    what: 'the image below is a screenshot a person took of the app\'s preview when you asked for one; it shows the app\'s own pages.',
    image: p.image,
    note: p.note,
  });
}
