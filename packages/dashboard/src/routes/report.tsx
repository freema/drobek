/**
 * /report?host= — client half: the public abuse report form.
 * No login. The host comes prefilled from `/.well-known/drobek-report` on the
 * app host; the reporter picks a reason, may add details (≤ 2 000 chars) and
 * an e-mail for follow-up. `website` is a honeypot (hidden from humans).
 */
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import { PlatformPage } from '@drobek/auth/platform-page';
import type { action, loader } from './report.server.js';

export function meta() {
  return [{ title: 'Report an app — drobek' }, { name: 'robots', content: 'noindex' }];
}

// Off-screen, not display:none — some bots skip hidden inputs.
const honeypot = { position: 'absolute', left: '-10000px', width: '1px', height: '1px', overflow: 'hidden' } as const;

export default function ReportRoute() {
  const { host, reasons, detailsMax } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';

  if (result?.ok) {
    return (
      <PlatformPage page="report">
        <h1>Report an app</h1>
        <p className="drobek-ok" data-testid="report-thanks" role="status">
          Thank you — your report was received. The operator of this server reviews every report. You can close this page.
        </p>
      </PlatformPage>
    );
  }
  const error = result && !result.ok ? result : null;

  return (
    <PlatformPage page="report">
      <h1>Report an app</h1>
      <p className="drobek-hint">
        Tell the operator of this server about an app that phishes, spreads malware, spams or otherwise breaks the
        terms of service. You do not need an account.
      </p>
      {error ? (
        <p className="drobek-error" role="alert" data-testid="report-error" data-field={error.field ?? ''}>
          {error.error}
        </p>
      ) : null}
      <Form method="post" data-testid="report-form">
        <label htmlFor="report-host" className="drobek-label">
          App address
        </label>
        <input
          id="report-host"
          name="host"
          required
          defaultValue={host}
          placeholder="my-app.example.com"
          className="drobek-input"
          data-testid="report-host"
        />
        <label htmlFor="report-reason" className="drobek-label">
          Reason
        </label>
        <select id="report-reason" name="reason" required defaultValue="" className="drobek-input" data-testid="report-reason">
          <option value="" disabled>
            Pick a reason…
          </option>
          {reasons.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <label htmlFor="report-details" className="drobek-label">
          Details (optional)
        </label>
        <textarea
          id="report-details"
          name="details"
          maxLength={detailsMax}
          className="drobek-input"
          placeholder="What is wrong with the app? Which page?"
          data-testid="report-details"
        />
        <p className="drobek-small" style={{ marginTop: '0.3rem' }}>
          At most {detailsMax} characters.
        </p>
        <label htmlFor="report-email" className="drobek-label">
          Your e-mail (optional, only if you want a follow-up)
        </label>
        <input id="report-email" name="email" type="email" autoComplete="email" className="drobek-input" data-testid="report-email" />
        <div style={honeypot} aria-hidden="true">
          <label htmlFor="report-website">Website</label>
          <input id="report-website" name="website" tabIndex={-1} autoComplete="off" />
        </div>
        <button type="submit" className="drobek-button" disabled={busy} data-testid="report-submit">
          Send report
        </button>
      </Form>
    </PlatformPage>
  );
}
