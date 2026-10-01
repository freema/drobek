/**
 * drobek-module-email — the BUILT-IN platform module `email`:
 * the app-facing e-mail policy of a drobek server.
 *
 *   DROBEK_MODULES=email   → this package (`modules/email` in the drobek repo,
 *                            a dependency of the server).
 *
 *   POST /__drobek/v1/email/notify-admins   drobek.email.notifyAdmins(subject, text)
 *   config { fromName?, replyTo? } — a new replyTo needs the owner's confirmation.
 *
 * It OWNS app e-mail (`mail`): core runs `prepare` for every `ctx.email.send`
 * of every module (forms notifications, notifyAdmins, auth sign-in codes)
 * — the per-app daily limit and the sender name / Reply-To. The transport
 * (SMTP, Resend, layout) is core (`@drobek/email`); other providers come as
 * modules through the `email.transport` slot this module hosts, selected by
 * EMAIL_TRANSPORT (core installs the chosen one); the recipients rule and the
 * operator-wide hourly cap with auto-pause are core too (`@drobek/modules`).
 * There is no "send to any address": an app can notify its owners, and
 * other modules send to owner-confirmed config addresses or verified users.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMAIL_TRANSPORT_SLOT, defineModule, emailTransportSchema } from '@drobek/modules';
import { EMAIL_CONFIG_DEFAULTS, emailConfigSchema, emailConfirmRequired, type EmailConfig } from './config.js';
import { prepareMail, registerRoutes } from './routes.js';

export { EMAIL_CONFIG_DEFAULTS, emailConfigSchema, emailConfirmRequired, type EmailConfig } from './config.js';
export { adminNotice, appDisplayName, notifyBody, oneLine, prepareMail } from './routes.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The SDK entry next to this file: dist/sdk.js when built, src/sdk.ts in a source checkout. */
const sdkEntry = existsSync(here('./sdk.js')) ? here('./sdk.js') : here('./sdk.ts');

export const SDK_TYPES = `
export interface Api {
  /**
   * E-mail the app's owners (the editors and admins of its drobek workspace).
   * Needs a signed-in user (auth module). subject ≤ 150, text ≤ 5000 characters.
   * Rejects: unauthorized (401), limit_exceeded (429), unavailable (503).
   */
  notifyAdmins(subject: string, text: string): Promise<{ sent: number }>;
}
`;

const email = defineModule<EmailConfig>({
  name: 'email',
  version: '1.0.0',
  contract: '^1.1',
  skill: {
    useWhen: 'the app must tell its owners about something by e-mail (a request, an alert), or you want to set the sender name of the app\'s e-mails',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  configSchema: emailConfigSchema,
  configDefaults: EMAIL_CONFIG_DEFAULTS,
  confirmRequired: emailConfirmRequired,
  rules: {
    ops: {
      notify_admins: "E-mail the app's owners (always a signed-in user)",
    },
  },
  limits: [
    {
      env: 'EMAIL_PER_APP_PER_DAY',
      default: 50,
      meaning: 'notification e-mails one app may send per day (form notifications + notifyAdmins; sign-in codes excluded)',
    },
    { env: 'EMAIL_NOTIFY_ADMINS_PER_DAY', default: 20, meaning: 'drobek.email.notifyAdmins() calls one app may make per day' },
  ],
  slots: {
    [EMAIL_TRANSPORT_SLOT]: {
      schema: emailTransportSchema,
      unique: 'id',
      description:
        "An e-mail provider for the whole server (SES, Postmark, a company relay, …), chosen with EMAIL_TRANSPORT=<id>: send({ from, to, subject, text, html, replyTo? }, { secrets, signal }). Secrets are the operator env vars it declares; smtp and resend stay built in.",
      operatorOnly: true,
    },
  },
  routes: registerRoutes,
  mail: { prepare: prepareMail },
  sdk: { entry: sdkEntry, types: SDK_TYPES },
});

export default email;
