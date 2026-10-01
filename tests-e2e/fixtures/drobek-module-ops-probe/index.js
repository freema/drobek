/**
 * drobek-module-ops-probe — the operator-only module of the e2e stacks (no
 * skill: apps, agents and app owners never see it). Installed like any
 * external module: packed and added with scripts/selfhost-module.sh
 * (`task module:fixture` for the dev stack, scripts/e2e-image.sh for the
 * image flow).
 *
 *  - `errors.reporter` `capture` (ERROR_REPORTER=capture): POSTs every report
 *    as JSON to OPSPROBE_URL + `/reports`, where tests-e2e/proxy-echo.mjs
 *    keeps it for the specs to read back;
 *  - `email.transport` `relay` (EMAIL_TRANSPORT=relay): hands every message
 *    to Mailpit's HTTP send API at OPSPROBE_MAIL_URL with the header
 *    `X-Ops-Probe-Transport: relay`; a recipient at `fail.example` is refused
 *    with an error naming the recipient and the relay URL, which the server
 *    must redact, and a random attempt id (letters) so that no two refusals
 *    share a fingerprint;
 *  - the server job `probe`: asks OPSPROBE_URL + `/job` whether a spec armed a
 *    failure and throws that message when it did.
 */
import { EmailSendError, defineEmailTransport, defineErrorReporter, defineModule, z } from '@drobek/modules';

const FAIL_DOMAIN = '@fail.example';

function attemptId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => String.fromCharCode(97 + (b % 26))).join('');
}

function postJson(url, body, signal) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
}

export default defineModule({
  name: 'opsprobe',
  version: '1.0.0',
  contract: '^1.2',
  configSchema: z.object({}),
  configDefaults: {},
  requires: ['email'],
  contributes: {
    'errors.reporter': defineErrorReporter({
      apiVersion: 1,
      id: 'capture',
      label: 'e2e report capture',
      secrets: ['OPSPROBE_URL'],
      async report(event, { secrets, signal }) {
        const res = await postJson(`${secrets.OPSPROBE_URL}/reports`, event, signal);
        if (!res.ok) throw new Error(`the capture answered HTTP ${res.status}`);
      },
    }),
    'email.transport': defineEmailTransport({
      apiVersion: 1,
      id: 'relay',
      label: 'e2e mail relay',
      secrets: ['OPSPROBE_MAIL_URL'],
      async send(message, { secrets, signal }) {
        if (message.to.toLowerCase().endsWith(FAIL_DOMAIN)) {
          throw new EmailSendError('rejected', `the relay at ${secrets.OPSPROBE_MAIL_URL} refused ${message.to} (attempt ${attemptId()})`);
        }
        const res = await postJson(
          secrets.OPSPROBE_MAIL_URL,
          {
            From: { Email: message.from.address, Name: message.from.name },
            To: [{ Email: message.to }],
            ...(message.replyTo ? { ReplyTo: [{ Email: message.replyTo }] } : {}),
            Subject: message.subject,
            Text: message.text,
            HTML: message.html,
            Headers: { 'X-Ops-Probe-Transport': 'relay' },
          },
          signal
        );
        if (!res.ok) throw new EmailSendError(res.status >= 500 ? 'unavailable' : 'rejected', `HTTP ${res.status}`, { status: res.status });
      },
    }),
  },
  jobs: [
    {
      name: 'probe',
      description: 'Fails once with the message an e2e spec armed on proxy-echo.',
      scope: 'server',
      every: '1h',
      async run({ signal }) {
        const base = process.env.OPSPROBE_URL;
        if (!base) return;
        const res = await fetch(`${base}/job`, { signal }).catch(() => null);
        if (!res?.ok) return;
        const { fail } = await res.json();
        if (typeof fail === 'string' && fail !== '') throw new Error(fail);
      },
    },
  ],
});
