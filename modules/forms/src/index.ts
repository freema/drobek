/**
 * drobek-module-forms — the BUILT-IN platform module `forms` (M1-04, §5.3):
 * an app's forms (contact, sign-up, feedback) without a backend.
 *
 *   DROBEK_MODULES=email,forms  → this package (`modules/forms` in the drobek
 *                                 repo, a dependency of the server). It
 *                                 REQUIRES the email module (notifications).
 *
 *   GET  /__drobek/v1/forms/:form/token        the time token `_t`
 *   POST /__drobek/v1/forms/:form              a submission (JSON or text-only multipart, 32 KiB)
 *   GET  /__drobek/v1/forms/:form/submissions  (.csv)  admin
 *   drobek.forms.prepare() / submit() / submissions() / csvUrl()
 *   import { Form } from 'drobek/forms'       (React, compiled into the app)
 *   config { forms: { <name>: { rules: { submit }, notify: { emails, owners } } } }
 *   — any change of notify.emails needs the owner's confirmation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineModule } from '@drobek/modules';
import { FORMS_CONFIG_DEFAULTS, formsConfigSchema, formsConfirmRequired, type FormsConfig } from './config.js';
import { submissionsAuthority } from './owner.js';
import { registerRoutes } from './routes.js';

export {
  FORM_NAME_RE,
  FORMS_CONFIG_DEFAULTS,
  formConfig,
  formsConfigSchema,
  formsConfirmRequired,
  type FormConfig,
  type FormsConfig,
} from './config.js';
export { MAX_FIELDS, fieldText, splitBody, validateFields } from './fields.js';
export { CSV_MAX_ROWS, notificationEmail, oneLine } from './routes.js';
export { ownerSubmission, submissionsAuthority, submissionsCsv } from './owner.js';
export { formSubmissions, type FieldValue, type FormSubmissionRow } from './schema.js';
export { FORM_MIN_FILL_MS, FORM_TOKEN_TTL_MS, checkFormToken, formsKey, ipHash, issueFormToken } from './token.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The SDK entry next to this file: dist/sdk.js when built, src/sdk.ts in a source checkout. */
const sdkEntry = existsSync(here('./sdk.js')) ? here('./sdk.js') : here('./sdk.ts');

export const SDK_TYPES = `
export type FieldValue = string | number | boolean | null | string[];
export interface Submission {
  id: string;
  created_at: string;
  data: Record<string, FieldValue>;
  user_id: string | null;
  notified: boolean;
}
export interface Api {
  /** Fetch the form's time token early (e.g. when the form mounts); submit() then never waits. */
  prepare(form: string): Promise<void>;
  /**
   * Store a submission (and e-mail the owners). Waits until the token is ≥ 2 s old.
   * FormData or a flat object; no files. Rejects: invalid_request (400), unauthorized (401),
   * rate_limited / limit_exceeded (429).
   */
  submit(form: string, data: Record<string, FieldValue> | FormData): Promise<{ ok: true; id: string }>;
  /** Newest first, ≤ 100 per page (admins only). */
  submissions(form: string, opts?: { limit?: number; before?: string }): Promise<{ submissions: Submission[]; next_cursor: string | null }>;
  /** The CSV export URL (admins only), e.g. for <a href download>. */
  csvUrl(form: string): string;
}
`;

export const INLINE_TYPES = `
import type { FormHTMLAttributes, JSX, ReactNode } from 'react';
export interface FormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'onError' | 'name' | 'action' | 'method' | 'children'> {
  /** The form's name: lowercase letters, digits, - and _ (max 40). */
  name: string;
  /** Your inputs (each with a name) and a submit button. */
  children: ReactNode;
  /** Shown instead of the fields after a successful submit (default "Thank you — sent."). */
  success?: ReactNode;
  onSuccess?: (result: { id: string }) => void;
  onError?: (error: { code: string; message: string }) => void;
}
export function Form(props: FormProps): JSX.Element;
`;

const forms = defineModule<FormsConfig>({
  name: 'forms',
  version: '1.0.0',
  requires: ['email'],
  skill: {
    useWhen: 'visitors fill in a form (contact, order, sign-up, feedback) and the answers must be kept or e-mailed to the owner',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  configSchema: formsConfigSchema,
  configDefaults: FORMS_CONFIG_DEFAULTS,
  confirmRequired: formsConfirmRequired,
  rules: {
    ops: {
      submit: 'Send a form (per form: public or user)',
      read: 'List and export the submissions (always admin)',
    },
  },
  limits: [
    { env: 'FORMS_SUBMITS_PER_IP_HOUR', default: 10, meaning: 'submissions one visitor IP may send to one app per hour' },
    { env: 'FORMS_PER_APP_PER_DAY', default: 200, meaning: 'submissions one app may take per day (all its forms)' },
  ],
  routes: registerRoutes,
  submissions: submissionsAuthority,
  sdk: {
    entry: sdkEntry,
    types: SDK_TYPES,
    inline: { entry: here('../sdk/forms.tsx'), types: INLINE_TYPES },
  },
  migrations: { folder: here('../migrations') },
});

export default forms;
