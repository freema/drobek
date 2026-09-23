/**
 * /report?host= — client half (M4-02, NSO-293): the public abuse report form.
 * No login. The host comes prefilled from `/.well-known/drobek-report` on the
 * app host; the reporter picks a reason, may add details (≤ 2 000 chars) and
 * an e-mail for follow-up. `website` is a honeypot (hidden from humans).
 */
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { action, loader } from './report.server.js';

export function meta() {
  return [{ title: 'Report an app — drobek' }, { name: 'robots', content: 'noindex' }];
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '36rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  label: { display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem', marginTop: '1rem' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '0.6rem 0.75rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
    background: '#fff',
  },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: '8rem',
    padding: '0.6rem 0.75rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
  },
  button: {
    marginTop: '1.25rem',
    padding: '0.6rem 1.1rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#fff',
    background: '#1a1a1a',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#b91c1c',
    padding: '0.6rem 0.9rem',
    borderRadius: '8px',
    marginTop: '1rem',
    fontSize: '0.9rem',
  },
  thanks: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#166534',
    padding: '0.9rem 1rem',
    borderRadius: '8px',
    marginTop: '1.5rem',
  },
  // Off-screen, not display:none — some bots skip hidden inputs.
  honeypot: { position: 'absolute', left: '-10000px', width: '1px', height: '1px', overflow: 'hidden' },
  small: { color: '#555', fontSize: '0.8rem', marginTop: '0.3rem' },
} as const;

export default function ReportRoute() {
  const { host, reasons, detailsMax } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';

  if (result?.ok) {
    return (
      <main style={styles.main}>
        <h1 style={styles.h1}>Report an app</h1>
        <p style={styles.thanks} data-testid="report-thanks" role="status">
          Thank you — your report was received. The operator of this server reviews every report.
        </p>
      </main>
    );
  }
  const error = result && !result.ok ? result : null;

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Report an app</h1>
      <p style={styles.hint}>
        Tell the operator of this server about an app that phishes, spreads malware, spams or otherwise breaks the
        terms of service. You do not need an account.
      </p>
      {error ? (
        <p style={styles.error} role="alert" data-testid="report-error" data-field={error.field ?? ''}>
          {error.error}
        </p>
      ) : null}
      <Form method="post" data-testid="report-form">
        <label htmlFor="report-host" style={styles.label}>
          App address
        </label>
        <input
          id="report-host"
          name="host"
          required
          defaultValue={host}
          placeholder="my-app.example.com"
          style={styles.input}
          data-testid="report-host"
        />
        <label htmlFor="report-reason" style={styles.label}>
          Reason
        </label>
        <select id="report-reason" name="reason" required defaultValue="" style={styles.input} data-testid="report-reason">
          <option value="" disabled>
            Pick a reason…
          </option>
          {reasons.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <label htmlFor="report-details" style={styles.label}>
          Details (optional)
        </label>
        <textarea
          id="report-details"
          name="details"
          maxLength={detailsMax}
          style={styles.textarea}
          placeholder="What is wrong with the app? Which page?"
          data-testid="report-details"
        />
        <p style={styles.small}>At most {detailsMax} characters.</p>
        <label htmlFor="report-email" style={styles.label}>
          Your e-mail (optional, only if you want a follow-up)
        </label>
        <input id="report-email" name="email" type="email" autoComplete="email" style={styles.input} data-testid="report-email" />
        <div style={styles.honeypot} aria-hidden="true">
          <label htmlFor="report-website">Website</label>
          <input id="report-website" name="website" tabIndex={-1} autoComplete="off" />
        </div>
        <button type="submit" style={styles.button} disabled={busy} data-testid="report-submit">
          Send report
        </button>
      </Form>
    </main>
  );
}
