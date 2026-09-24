/**
 * GET/POST /report?host= — server half (M4-02, NSO-293): the public abuse
 * report form on the DASHBOARD origin (every app host points here through
 * `/.well-known/drobek-report`). No login.
 *
 * POST, in order: the honeypot (`website` filled → a silent "thanks", nothing
 * stored); the input (`validateAbuseReport`: host, reason, details ≤ 2 000
 * chars, optional reporter e-mail → 400 with the field); the rate limit
 * (ABUSE_REPORTS_PER_IP_HOUR valid reports per client IP per hour, default 5
 * → 429); then the report is stored (`abuse_reports`, audit `abuse.report`
 * when the host belongs to an app) and the super-admins are e-mailed (at most
 * once per app per hour).
 */
import { data, type ActionFunctionArgs, type HeadersArgs, type LoaderFunctionArgs } from 'react-router';
import {
  LOCK_REASONS,
  REPORT_DETAILS_MAX,
  createAbuseReport,
  normalizeReportHost,
  reasonLabel,
  validateAbuseReport,
} from '@drobek/apps';
import { getClientIp, rateLimitRedis } from '@drobek/auth';
import { createConsoleLogger } from '@drobek/core';
import { mailSuperAdminsAboutReport } from '../abuse-mail.server.js';

const log = createConsoleLogger('abuse');

/** Valid reports per client IP per hour. */
export function reportsPerIpHour(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ABUSE_REPORTS_PER_IP_HOUR);
  return Number.isInteger(n) && n > 0 ? n : 5;
}
const HOUR_MS = 60 * 60 * 1000;

export const REPORT_RATE_BUCKET = 'abuse-report-ip';

/**
 * Without a `headers` export React Router drops the headers an action puts on
 * `data()` — the 429 must reach the wire with its `Retry-After` (M4-02).
 */
export function headers({ actionHeaders }: HeadersArgs) {
  return actionHeaders;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return data(
    {
      host: normalizeReportHost(url.searchParams.get('host') ?? '') ?? '',
      reasons: LOCK_REASONS.map((value) => ({ value, label: reasonLabel(value) })),
      detailsMax: REPORT_DETAILS_MAX,
    },
    { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } }
  );
}

type ActionResult =
  | { ok: true }
  | { ok: false; field?: string; error: string };

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return data<ActionResult>({ ok: false, error: 'Use the form.' }, { status: 405 });
  }
  const form = await request.formData();
  // Honeypot: humans never see this field; a bot that fills it gets a thank-you and nothing is stored.
  if (String(form.get('website') ?? '').trim() !== '') {
    log.info('abuse report honeypot tripped — dropped', { event: 'abuse_report_honeypot' });
    return data<ActionResult>({ ok: true });
  }
  const input = {
    host: String(form.get('host') ?? ''),
    reason: String(form.get('reason') ?? ''),
    details: String(form.get('details') ?? ''),
    reporterEmail: String(form.get('email') ?? ''),
  };
  const v = validateAbuseReport(input);
  if (!v.ok) return data<ActionResult>({ ok: false, field: v.field, error: v.message }, { status: 400 });

  const ip = getClientIp(request);
  const limit = await rateLimitRedis(REPORT_RATE_BUCKET, ip ?? 'unknown', reportsPerIpHour(), HOUR_MS);
  if (!limit.ok) {
    return data<ActionResult>(
      { ok: false, error: 'Too many reports from your network in the last hour. Try again later.' },
      { status: 429, headers: { 'Retry-After': '3600' } }
    );
  }

  const report = await createAbuseReport({ ...input, clientIp: ip });
  log.warn('abuse report received', {
    event: 'abuse_report',
    report_id: report.id,
    host: report.host,
    reason: report.reason,
    app_id: report.app?.id ?? null,
  });
  await mailSuperAdminsAboutReport(
    {
      reportId: report.id,
      host: report.host,
      reason: report.reason,
      details: v.value.details,
      reporterEmail: v.value.reporterEmail,
      app: report.app,
    },
    log
  );
  return data<ActionResult>({ ok: true });
}
