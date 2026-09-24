/**
 * The forms module's per-app config: per form, who may submit and who gets
 * the notification e-mail. A form that is not configured works with the
 * defaults (anyone may submit, the app's owners are notified), so
 * `<Form name="contact">` works before any configure_module call.
 *
 * Changing `notify.emails` (adding OR removing an address) needs the owner's
 * confirmation: otherwise an agent could send the leads somewhere else.
 */
import { z } from '@drobek/modules';

/** Form names: URL-, config-path- and file-name-safe. */
export const FORM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_FORMS = 50;
const MAX_NOTIFY_EMAILS = 10;

const email = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'must be an e-mail address' }));

const formConfigSchema = z.strictObject({
  rules: z
    .strictObject({
      /** Who may submit: anyone, or only signed-in users (auth module). */
      submit: z.enum(['public', 'user']).default('public'),
    })
    .default({ submit: 'public' }),
  notify: z
    .strictObject({
      /** Extra addresses that get every submission (owner-confirmed). */
      emails: z.array(email).max(MAX_NOTIFY_EMAILS).default([]),
      /** E-mail the app's owners (editors + workspace admins). */
      owners: z.boolean().default(true),
    })
    .default({ emails: [], owners: true }),
});

export type FormConfig = z.infer<typeof formConfigSchema>;

export const formsConfigSchema = z.strictObject({
  forms: z
    .record(z.string().regex(FORM_NAME_RE, 'form names are lowercase letters, digits, - and _ (max 40)'), formConfigSchema)
    .refine((f) => Object.keys(f).length <= MAX_FORMS, `at most ${MAX_FORMS} forms`)
    .default({}),
});

export type FormsConfig = z.infer<typeof formsConfigSchema>;

export const FORMS_CONFIG_DEFAULTS: FormsConfig = { forms: {} };

/** The config of one form: its own entry, or the defaults. */
export function formConfig(config: FormsConfig, form: string): FormConfig {
  const own = Object.prototype.hasOwnProperty.call(config.forms, form) ? config.forms[form] : undefined;
  return own ?? formConfigSchema.parse({});
}

function list(emails: string[]): string {
  return emails.length ? `[${emails.join(', ')}]` : '[]';
}

/** Any change of a form's notification addresses waits for the owner. */
export function formsConfirmRequired(before: FormsConfig, after: FormsConfig): string[] {
  const out: string[] = [];
  const names = [...new Set([...Object.keys(before.forms), ...Object.keys(after.forms)])].sort();
  for (const name of names) {
    const b = [...formConfig(before, name).notify.emails].sort();
    const a = [...formConfig(after, name).notify.emails].sort();
    if (b.join(',') !== a.join(',')) {
      out.push(`forms.${name}.notify.emails: ${list(b)} → ${list(a)} (who gets the "${name}" submissions by e-mail)`);
    }
  }
  return out;
}
