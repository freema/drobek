/**
 * The email module's per-app config: how the app's e-mails look to the
 * recipient. The sender ADDRESS is always the operator's EMAIL_FROM (SPF/DKIM
 * of the operator's domain); an app only chooses the display name and a
 * Reply-To. A new Reply-To needs the owner's confirmation: it decides where
 * the owner's own replies to notifications go.
 */
import { z } from '@drobek/modules';

const NAME_FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029"<>@\\]/;

export const emailConfigSchema = z.strictObject({
  /** Display name of the sender, e.g. "Acme bakery" (the address stays the server's). */
  fromName: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .refine((v) => !NAME_FORBIDDEN.test(v), 'one plain line without quotes, angle brackets, @ or backslashes')
    .optional(),
  /** Where replies to the app's e-mails go (needs the owner's confirmation). */
  replyTo: z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'must be an e-mail address' })).optional(),
});

export type EmailConfig = z.infer<typeof emailConfigSchema>;

export const EMAIL_CONFIG_DEFAULTS: EmailConfig = {};

/** A new or changed Reply-To waits for the owner (§5.0: recipients of the app's mail are the owner's call). */
export function emailConfirmRequired(before: EmailConfig, after: EmailConfig): string[] {
  if (after.replyTo && after.replyTo !== before.replyTo) {
    return [`replyTo: ${before.replyTo ?? '(none)'} → ${after.replyTo} (replies to this app's e-mails go there)`];
  }
  return [];
}
