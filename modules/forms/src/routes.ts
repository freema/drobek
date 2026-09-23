/**
 * `/__drobek/v1/forms/…` on every app host:
 *
 *   GET  :form/token             → { token, min_wait_ms, expires_in }   (public)
 *   POST :form                   → { ok: true, id }                    (the form's rule: public | user)
 *   GET  :form/submissions       → { submissions, next_cursor }        (admin)
 *   GET  :form/submissions.csv   → text/csv attachment                 (admin)
 *
 * A submission, in order: the per-IP hourly limit (router) → the form's
 * rule → a filled honeypot `_hp` is dropped SILENTLY (200 like a success,
 * nothing stored or sent, a counter in the log) → the time token `_t` (this
 * app + form, ≥ 2 s old) → field validation → the per-app daily limit →
 * stored → the notification e-mail (to the owner-confirmed `notify.emails`
 * and/or the app's owners, through the email module). A notification that
 * cannot be sent (limits, pause, SMTP) never loses the submission.
 *
 * Field values are end-user data: they are never logged, and only the app's
 * admins read them back (no-store).
 */
import { dashboardOrigin } from '@drobek/apps';
import { csvLine } from '@drobek/data/columns';
import { ModuleError, isModuleError, respond, z, type EmailRecipient, type ModuleContext, type ModuleRouter } from '@drobek/modules';
import { FORM_NAME_RE, formConfig, type FormConfig, type FormsConfig } from './config.js';
import { fieldText, splitBody, validateFields } from './fields.js';
import type { FieldValue } from './schema.js';
import { appInfo, decodeCursor, encodeCursor, insertSubmission, listSubmissions, markNotified, newSubmissionId } from './submissions.js';
import { FORM_MIN_FILL_MS, FORM_TOKEN_TTL_MS, checkFormToken, formsKey, ipHash, issueFormToken } from './token.js';

type Ctx = ModuleContext<FormsConfig>;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
export const CSV_MAX_ROWS = 10_000;
const MAX_APP_NAME = 60;

function formParam(raw: string): string {
  if (!FORM_NAME_RE.test(raw)) {
    throw new ModuleError('invalid_request', 'Form names are lowercase letters, digits, - and _ (max 40 characters).', {
      details: [{ path: 'form', message: 'must match ^[a-z0-9][a-z0-9_-]{0,39}$' }],
    });
  }
  return raw;
}

function key(): Buffer {
  const k = formsKey();
  if (!k) throw new ModuleError('unavailable', 'Forms are not available on this server (it has no DROBEK_MASTER_KEY).');
  return k;
}

/** One line of plain text (no control characters), capped. */
export function oneLine(text: string, max = MAX_APP_NAME): string {
  const clean = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** The Host header, if it is a plain host[:port]. */
function safeHost(host: string | null): string | null {
  const h = (host ?? '').trim().toLowerCase();
  return /^[a-z0-9.-]+(?::\d{1,5})?$/.test(h) ? h : null;
}

/** The notification e-mail for one submission (plain text: the layout escapes it). */
export function notificationEmail(input: {
  appName: string;
  form: string;
  id: string;
  fields: Record<string, FieldValue>;
  host: string | null;
  link: string | null;
  at: Date;
}): { subject: string; text: string } {
  const lines = [`New submission of the form "${input.form}" in ${input.appName}.`, ''];
  for (const [k, v] of Object.entries(input.fields)) {
    const text = fieldText(v);
    if (text.includes('\n')) lines.push(`${oneLine(k, 64)}:`, ...text.replace(/\r\n?/g, '\n').split('\n').map((l) => `  ${l}`));
    else lines.push(`${oneLine(k, 64)}: ${text}`);
  }
  lines.push('', `Submission ${input.id} · ${input.at.toISOString()}${input.host ? ` · ${input.host}` : ''}`);
  if (input.link) lines.push(`Open the app in drobek: ${input.link}`);
  lines.push('The app\'s admins can list and export every submission (sign in to the app).');
  return { subject: `New "${input.form}" submission — ${input.appName}`, text: lines.join('\n') };
}

function recipientsOf(form: string, fc: FormConfig): EmailRecipient[] {
  const out: EmailRecipient[] = [];
  if (fc.notify.emails.length > 0) out.push({ config: `forms.${form}.notify.emails` });
  if (fc.notify.owners) out.push({ appOwners: true });
  return out;
}

/** Send the notification; false when nobody is configured or it could not be sent (logged without values). */
async function notify(ctx: Ctx, input: { form: string; fc: FormConfig; id: string; fields: Record<string, FieldValue>; host: string | null }): Promise<boolean> {
  const to = recipientsOf(input.form, input.fc);
  if (to.length === 0) return false;
  try {
    const info = await appInfo(ctx.db, ctx.app.id);
    const appName = oneLine(info.name?.trim() || ctx.app.slug) || ctx.app.slug;
    const link = info.workspaceSlug
      ? `${dashboardOrigin()}/workspaces/${encodeURIComponent(info.workspaceSlug)}/apps/${encodeURIComponent(ctx.app.slug)}`
      : null;
    const message = notificationEmail({ appName, form: input.form, id: input.id, fields: input.fields, host: input.host, link, at: new Date() });
    const out = await ctx.email.send({ to, ...message });
    return out.sent > 0;
  } catch (err) {
    ctx.log.warn('forms: notification not sent (the submission is stored)', {
      event: 'forms_notify_failed',
      app_id: ctx.app.id,
      form: input.form,
      submission: input.id,
      reason: isModuleError(err) ? err.code : 'error',
      ...(isModuleError(err) ? {} : { error: String((err as Error)?.message ?? err) }),
    });
    return false;
  }
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().max(200).optional(),
});

export function registerRoutes(r: ModuleRouter<FormsConfig>): void {
  r.get('/:form/token', { rule: 'public' }, (req, ctx) => {
    const form = formParam(req.params.form);
    return {
      token: issueFormToken(key(), ctx.app.id, form),
      min_wait_ms: FORM_MIN_FILL_MS,
      expires_in: FORM_TOKEN_TTL_MS / 1000,
    };
  });

  r.post(
    '/:form',
    {
      rateLimit: { bucket: 'submit-ip', max: 'FORMS_SUBMITS_PER_IP_HOUR', windowMs: HOUR_MS, per: 'ip' },
      maxBodyBytes: 32 * 1024,
      bodyTypes: ['json', 'multipart'],
    },
    async (req, ctx) => {
      const form = formParam(req.params.form);
      const fc = formConfig(ctx.config, form);
      const decision = ctx.rules.decide(fc.rules.submit);
      if (!decision.ok) {
        throw decision.status === 401
          ? new ModuleError('unauthorized', 'Sign in to this app first: this form takes submissions from signed-in users only.')
          : new ModuleError('forbidden', 'You may not submit this form.');
      }
      const k = key();
      const { honeypot, token, data } = splitBody(req.body);

      if (honeypot) {
        // A bot filled the invisible field: answer like a success, keep nothing.
        const c = await ctx.rateLimit('honeypot', 'day', Number.MAX_SAFE_INTEGER, DAY_MS);
        ctx.log.info('forms: honeypot submission dropped', {
          event: 'forms_honeypot_drop',
          app_id: ctx.app.id,
          form,
          dropped_today: c.count,
        });
        return { ok: true, id: newSubmissionId() };
      }

      const t = checkFormToken(k, token, ctx.app.id, form);
      if (!t.ok) {
        if (t.reason === 'too_fast') {
          throw new ModuleError('submitted_too_fast', 'The form was sent too fast after it was loaded. Wait a moment and send it again.', {
            status: 429,
            details: { min_wait_ms: FORM_MIN_FILL_MS },
            headers: { 'Retry-After': String(Math.max(1, Math.ceil(t.waitMs / 1000))) },
          });
        }
        throw new ModuleError(
          'invalid_form_token',
          t.reason === 'expired'
            ? 'The form token expired (2 hours). Get a new one from GET /__drobek/v1/forms/<form>/token (the SDK does this).'
            : '`_t` is missing or not a token of this form. Get one from GET /__drobek/v1/forms/<form>/token (the SDK does this).',
          { status: 400, details: { reason: t.reason } }
        );
      }

      const fields = validateFields(data);
      const max = (await ctx.limits()).FORMS_PER_APP_PER_DAY;
      const day = await ctx.rateLimit('app-day', 'all', max, DAY_MS);
      if (!day.ok) {
        throw new ModuleError('limit_exceeded', `This app already took its ${max} form submissions for today.`, {
          details: { limit: 'FORMS_PER_APP_PER_DAY', value: max },
          headers: { 'Retry-After': String(day.retryAfterSec) },
        });
      }

      const id = newSubmissionId();
      await insertSubmission(ctx.db, {
        id,
        appId: ctx.app.id,
        form,
        data: fields,
        ipHash: ipHash(k, ctx.app.id, req.clientIp),
        userId: ctx.principal.kind === 'user' ? ctx.principal.id : null,
      });
      if (await notify(ctx, { form, fc, id, fields, host: safeHost(req.header('host')) })) {
        await markNotified(ctx.db, ctx.app.id, id);
      }
      ctx.log.info('forms: submission stored', { app_id: ctx.app.id, form, submission: id, fields: Object.keys(fields).length });
      return { ok: true, id };
    }
  );

  r.get('/:form/submissions', { rule: 'admin', query: listQuery }, async (req, ctx) => {
    const form = formParam(req.params.form);
    const before = decodeCursor(req.query.before);
    if (req.query.before && !before) {
      throw new ModuleError('invalid_request', 'The `before` cursor is not valid.', { details: [{ path: 'before', message: 'use next_cursor from the previous page' }] });
    }
    const rows = await listSubmissions(ctx.db, ctx.app.id, form, req.query.limit + 1, before);
    const page = rows.slice(0, req.query.limit);
    return {
      submissions: page.map((row) => ({
        id: row.id,
        created_at: row.createdAt.toISOString(),
        data: row.data,
        user_id: row.userId,
        notified: row.notifiedAt !== null,
      })),
      next_cursor: rows.length > req.query.limit ? encodeCursor(page[page.length - 1]) : null,
    };
  });

  r.get('/:form/submissions.csv', { rule: 'admin' }, async (req, ctx) => {
    const form = formParam(req.params.form);
    const rows = await listSubmissions(ctx.db, ctx.app.id, form, CSV_MAX_ROWS, null);
    // Postgres jsonb does not keep the submitted key order: columns are sorted by name.
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row.data)))].sort();
    const own = (data: Record<string, FieldValue>, k: string) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : undefined);
    const lines = [
      csvLine(['id', 'created_at', ...columns]),
      ...rows.map((row) => csvLine([row.id, row.createdAt.toISOString(), ...columns.map((k) => fieldText(own(row.data, k)))])),
    ];
    await ctx.audit('export', { form, rows: rows.length });
    return respond(200, `${lines.join('\r\n')}\r\n`, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${form}-submissions.csv"`,
    });
  });
}
