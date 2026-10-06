/**
 * The owner's module tabs of an app over MCP — parity with the dashboard's
 * Forms, Users and Uploads tabs and a module's secrets form:
 *
 *   list_form_submissions / delete_form_submission  (the `submissions` authority, forms)
 *   list_end_users / set_end_user_role / set_end_user_blocked / sign_out_end_users  (`endUsers`, auth)
 *   list_uploads / delete_upload  (`files`, files)
 *   remove_module_secret  (the module secret store)
 *
 * Every body goes through the SAME module-runtime binding as the dashboard
 * (never a module's tables), with the dashboard's role floors: viewer+ reads,
 * editor+ changes. Like the dashboard tabs, a taken-down app still lets its
 * owner read and take away (delete, block, sign out, remove a secret); a role
 * change writes the auth config, so it takes the single-writer lease like
 * configure_module. Each change writes the dashboard's audit row with the
 * agent as the actor — ids, counts and names, never an address or a value.
 * The lists answer inside an untrusted envelope (owner-list.ts); the change
 * answers carry ids, roles and states only, never an end user's address.
 */
import { AUDIT_ACTIONS, actorKindForSurface, writeAudit } from '@drobek/audit';
import { confirmUrl, deleteModuleSecret, isAppFacing, isModuleError, secretsSet, type EndUserRecord, type HookApp } from '@drobek/modules';
import { authorizeApp } from './access.js';
import { ToolError } from './errors.js';
import { budgetFlags, cappedPage, cursorArg, dayArg, dayRange, limitArg, textArg, type OwnerListPayload } from './owner-list.js';
import type { AppRow } from './queries.js';
import { takeLease, type CallContext } from './tools.js';

const SUBMISSIONS_DEFAULT = 20;
const END_USERS_DEFAULT = 50;
const UPLOADS_DEFAULT = 50;
const FORM_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function hookApp(app: AppRow): HookApp {
  return { id: app.id, slug: app.slug, workspaceId: app.workspaceId };
}

function idArg(raw: unknown, what: string, where: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) throw new ToolError('invalid_params', `\`${what}\` must be the id ${where} lists.`);
  return raw;
}

function noModule(what: string): ToolError {
  return new ToolError('not_found', `This server has no module that keeps ${what}.`, { hint: 'skill_info()' });
}

/**
 * A module error as the tool error the agent acts on: a bad filter or cursor
 * → invalid_params, an unknown entry → not_found, a change the module refuses
 * → conflict (+ its `reason`), a method the module lacks → unavailable.
 * Anything else stays as it is (internal_error).
 */
async function moduleCall<T>(module: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isModuleError(err)) throw err;
    const details = err.details && typeof err.details === 'object' && !Array.isArray(err.details) ? (err.details as Record<string, unknown>) : {};
    const hint = { hint: `skill_info('${module}')` };
    switch (err.code) {
      case 'invalid_request':
        throw new ToolError('invalid_params', err.message, hint);
      case 'not_found':
        throw new ToolError('not_found', err.message, hint);
      case 'conflict':
        throw new ToolError('conflict', err.message, { ...(typeof details.reason === 'string' ? { reason: details.reason } : {}), ...hint });
      case 'unavailable':
        throw new ToolError('unavailable', err.message, hint);
      default:
        throw err;
    }
  }
}

async function audit(ctx: CallContext, app: AppRow, action: string, meta: Record<string, unknown>): Promise<void> {
  await writeAudit({
    workspaceId: app.workspaceId,
    actorUserId: ctx.principal.userId,
    actorKind: actorKindForSurface('mcp'),
    action,
    subjectType: 'app',
    target: app.slug,
    meta,
  });
}

// ── form submissions ─────────────────────────────────────────────────────────

export async function listFormSubmissionsTool(
  ctx: CallContext,
  args: { app_id: string; form?: string; from?: string; to?: string; limit?: number; cursor?: string }
): Promise<OwnerListPayload> {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  const form = textArg(args.form, 'form', 40);
  if (form !== undefined && !FORM_RE.test(form)) throw new ToolError('invalid_params', '`form` must be a form name of the app (lowercase letters, digits, - and _).');
  const range = dayRange(dayArg(args.from, 'from'), dayArg(args.to, 'to'));
  const limit = limitArg(args.limit, SUBMISSIONS_DEFAULT);
  const cursor = cursorArg(args.cursor);
  const subs = await ctx.modules.submissions(hookApp(app));
  if (!subs) throw noModule('form submissions');
  const forms = await moduleCall(subs.module, () => subs.forms());
  const read = await moduleCall(subs.module, () =>
    cappedPage(
      (n) => subs.list({ form, from: range.start?.toISOString(), to: range.until?.toISOString(), limit: n, cursor }),
      (p) => p.submissions,
      limit
    )
  );
  const flags = budgetFlags(read, 'call again with next_cursor for the rest.', "the dashboard's Forms tab shows it in full.");
  const filtered = form !== undefined || range.start !== null || range.until !== null;
  const empty =
    read.entries.length > 0 || cursor
      ? null
      : forms.length === 0
        ? 'The app has no forms and nothing was submitted: skill_info(\'forms\') shows how to declare one.'
        : forms.every((f) => f.submissions === 0)
          ? 'Nothing was submitted yet.'
          : filtered
            ? 'No submission matches this filter; the app has submissions outside it (`forms` counts them).'
            : 'Nothing was submitted yet.';
  const notes = [...flags.notes, ...(empty ? [empty] : [])];
  return {
    app_id: app.id,
    forms,
    filter: { ...(form ? { form } : {}), ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) },
    total: read.page.total,
    submissions: read.entries,
    next_cursor: read.page.next_cursor,
    ...(flags.cut ? { cut: true } : {}),
    ...(flags.clipped ? { clipped: true } : {}),
    untrusted: true,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

export async function deleteFormSubmissionTool(ctx: CallContext, args: { app_id: string; id: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  const id = idArg(args.id, 'id', 'list_form_submissions');
  const subs = await ctx.modules.submissions(hookApp(app));
  if (!subs) throw noModule('form submissions');
  if (!(await moduleCall(subs.module, () => subs.remove(id)))) {
    throw new ToolError('not_found', `No form submission "${id}" in this app.`, { hint: 'list_form_submissions lists the submissions with their id.' });
  }
  await audit(ctx, app, AUDIT_ACTIONS.formsSubmissionDelete, { module: subs.module, submission: id });
  return { app_id: app.id, id, deleted: true };
}

// ── end users ────────────────────────────────────────────────────────────────

/** An end user as a change answers it: no address (that stays inside list_end_users' envelope). */
function endUserState(u: EndUserRecord) {
  return { id: u.id, role: u.role, role_source: u.roleSource, status: u.status };
}

export async function listEndUsersTool(
  ctx: CallContext,
  args: { app_id: string; search?: string; limit?: number; cursor?: string }
): Promise<OwnerListPayload> {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  const search = textArg(args.search, 'search', 254);
  const limit = limitArg(args.limit, END_USERS_DEFAULT);
  const cursor = cursorArg(args.cursor);
  const endUsers = await ctx.modules.endUsers(hookApp(app));
  if (!endUsers) throw noModule('end users (sign-in)');
  const read = await moduleCall(endUsers.module, () =>
    cappedPage(
      (n) => endUsers.list({ search, limit: n, cursor }),
      (p) =>
        p.users.map((u) => ({
          id: u.id,
          email: u.email,
          role: u.role,
          role_source: u.roleSource,
          status: u.status,
          provider: u.provider ?? null,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at,
        })),
      limit
    )
  );
  const flags = budgetFlags(read, 'call again with next_cursor for the rest.', "the dashboard's Users tab shows it in full.");
  const empty = read.entries.length > 0 || cursor ? null : search ? 'No end user\'s address contains this text.' : 'Nobody has signed in to this app yet.';
  const notes = [...flags.notes, ...(empty ? [empty] : [])];
  return {
    app_id: app.id,
    ...(search ? { search } : {}),
    total: read.page.total,
    users: read.entries,
    next_cursor: read.page.next_cursor,
    ...(flags.cut ? { cut: true } : {}),
    ...(flags.clipped ? { clipped: true } : {}),
    untrusted: true,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

export async function setEndUserRoleTool(ctx: CallContext, args: { app_id: string; user_id: string; role: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  const id = idArg(args.user_id, 'user_id', 'list_end_users');
  if (args.role !== 'user' && args.role !== 'admin') throw new ToolError('invalid_params', '`role` must be "user" or "admin".');
  const role = args.role;
  const endUsers = await ctx.modules.endUsers(hookApp(app));
  if (!endUsers) throw noModule('end users (sign-in)');
  await takeLease(ctx, app.id);
  const user = await moduleCall(endUsers.module, () => endUsers.setRole(id, role, ctx.principal.userId, 'mcp'));
  return {
    app_id: app.id,
    user: endUserState(user),
    note: `The role follows the ${endUsers.module} config (get_app shows it), so this changed the config; it applies to the user's next request.`,
  };
}

export async function setEndUserBlockedTool(ctx: CallContext, args: { app_id: string; user_id: string; blocked: boolean }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  const id = idArg(args.user_id, 'user_id', 'list_end_users');
  if (typeof args.blocked !== 'boolean') throw new ToolError('invalid_params', '`blocked` must be true (block) or false (unblock).');
  const endUsers = await ctx.modules.endUsers(hookApp(app));
  if (!endUsers) throw noModule('end users (sign-in)');
  const user = await moduleCall(endUsers.module, () => endUsers.setDisabled(id, args.blocked));
  if (!user) throw new ToolError('not_found', `No end user "${id}" in this app.`, { hint: 'list_end_users lists them with their id.' });
  await audit(ctx, app, args.blocked ? AUDIT_ACTIONS.endUserDisable : AUDIT_ACTIONS.endUserEnable, { module: endUsers.module, end_user: id });
  return {
    app_id: app.id,
    user: endUserState(user),
    note: args.blocked
      ? 'Blocked: from their next request the user is anonymous on every host of the app and their sessions end. blocked: false lets them sign in again.'
      : 'Unblocked: the user signs in again with an enabled sign-in method.',
  };
}

export async function signOutEndUsersTool(ctx: CallContext, args: { app_id: string; user_confirmed?: boolean }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (args.user_confirmed !== true) {
    const endUsers = await ctx.modules.endUsers(hookApp(app));
    const total = endUsers ? (await moduleCall(endUsers.module, () => endUsers.list({ limit: 1 }))).total : null;
    const who = total === null ? 'every end user' : total === 1 ? 'its 1 end user' : `all its ${total} end users`;
    throw new ToolError(
      'user_confirmation_required',
      `Signing everyone out of "${app.name ?? app.slug}" ends the sessions of ${who} on every host of the app at once; each signs in again. Ask the user whether to sign everyone out, and call again with user_confirmed: true only after they say yes.`,
      total === null ? {} : { end_users: total }
    );
  }
  const epoch = await ctx.deps.revokeEndUserSessions(app.id);
  await audit(ctx, app, AUDIT_ACTIONS.endUserSessionsRevoke, { epoch });
  return {
    app_id: app.id,
    signed_out: true,
    note: 'Every end user is signed out on every host of the app from their next request; they sign in again with an enabled sign-in method.',
  };
}

// ── uploads ──────────────────────────────────────────────────────────────────

export async function listUploadsTool(ctx: CallContext, args: { app_id: string; limit?: number; cursor?: string }): Promise<OwnerListPayload> {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  const limit = limitArg(args.limit, UPLOADS_DEFAULT);
  const cursor = cursorArg(args.cursor);
  const files = await ctx.modules.files(hookApp(app));
  if (!files) throw noModule('end-user uploads');
  const read = await moduleCall(files.module, () =>
    cappedPage(
      (n) => files.list({ limit: n, cursor }),
      (p) => p.files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, uploaded_by: f.owner, created_at: f.created_at })),
      limit
    )
  );
  const flags = budgetFlags(read, 'call again with next_cursor for the rest.', "the dashboard's Uploads tab shows it in full.");
  const empty = read.entries.length > 0 || cursor ? null : 'Nobody has uploaded a file to this app yet.';
  const notes = [...flags.notes, ...(empty ? [empty] : [])];
  return {
    app_id: app.id,
    used_bytes: read.page.used_bytes,
    quota_bytes: read.page.quota_bytes,
    uploads: read.entries,
    next_cursor: read.page.next_cursor,
    ...(flags.cut ? { cut: true } : {}),
    ...(flags.clipped ? { clipped: true } : {}),
    untrusted: true,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

export async function deleteUploadTool(ctx: CallContext, args: { app_id: string; id: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  const id = idArg(args.id, 'id', 'list_uploads');
  const files = await ctx.modules.files(hookApp(app));
  if (!files) throw noModule('end-user uploads');
  if (!(await moduleCall(files.module, () => files.remove(id)))) {
    throw new ToolError('not_found', `No upload "${id}" in this app.`, { hint: 'list_uploads lists the uploads with their id.' });
  }
  await audit(ctx, app, AUDIT_ACTIONS.filesDelete, { module: files.module, id });
  return { app_id: app.id, id, deleted: true, note: 'The file is gone: the app\'s links to it answer 404 now.' };
}

// ── module secrets ───────────────────────────────────────────────────────────

const SECRET_REMOVE_ACTION = 'module.secret_remove';

export async function removeModuleSecretTool(ctx: CallContext, args: { app_id: string; module: string; name: string; user_confirmed?: boolean }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  const m = typeof args.module === 'string' ? ctx.modules.get(args.module) : undefined;
  if (!m) {
    throw new ToolError('not_found', `This server has no module "${String(args.module)}".`, { available: ctx.modules.summary().map((s) => s.name), hint: 'skill_info()' });
  }
  const docs = isAppFacing(m) ? (await ctx.modules.moduleView(hookApp(app), m.name)).secrets : [];
  const declared = docs.map((s) => s.name);
  if (typeof args.name !== 'string' || !declared.includes(args.name)) {
    throw new ToolError('not_found', `The ${m.name} module declares no secret "${String(args.name)}".`, { secrets: declared, hint: `skill_info('${m.name}')` });
  }
  const name = args.name;
  const secretsUrl = `${confirmUrl(ctx.modules.deps.env, app.workspaceSlug, app.slug, m.name)}#secrets`;
  if (!(await secretsSet(app.id, m.name, [name])).has(name)) {
    return { app_id: app.id, module: m.name, name, removed: false, note: `${name} is not set for this app: nothing to remove.` };
  }
  if (args.user_confirmed !== true) {
    const required = docs.find((s) => s.name === name)?.required === true;
    throw new ToolError(
      'user_confirmation_required',
      `Removing ${name} deletes its stored value for "${app.name ?? app.slug}" at once: what the ${m.name} module needs it for stops working${required ? ' (the module requires it)' : ''}, and only the owner can set a value again, in the dashboard — never through you. Ask the user whether to remove ${name}, and call again with user_confirmed: true only after they say yes.`,
      { module: m.name, name, required }
    );
  }
  const removed = await deleteModuleSecret(app.id, m.name, name);
  if (removed) await audit(ctx, app, SECRET_REMOVE_ACTION, { module: m.name, name });
  return {
    app_id: app.id,
    module: m.name,
    name,
    removed,
    secrets_url: secretsUrl,
    note: removed
      ? `${name} is no longer set (get_app shows hasSecret: false). A new value is set only by the owner on the module's page in the dashboard (secrets_url) — never ask for it in chat.`
      : `${name} is not set for this app: nothing to remove.`,
  };
}
