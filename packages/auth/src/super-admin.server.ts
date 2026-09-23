/**
 * SUPERADMIN_EMAIL bootstrap — a computed GLOBAL flag, NOT a memberships role
 * and NOT a DB column (see packages/db/src/schema.ts header). Empty env means
 * nobody is super-admin.
 *
 * U3 amendment (operator decree 2026-07-02): the env var accepts a
 * COMMA-SEPARATED list of emails (e.g. "a@x.cz,b@y.com"); every entry is
 * normalized (trim + lowercase) and empty entries are ignored. The original
 * single-value form keeps working unchanged.
 */
export function isSuperAdmin(
  email: string,
  superAdminEmail: string | undefined = process.env.SUPERADMIN_EMAIL
): boolean {
  const targets = superAdminEmails(superAdminEmail);
  if (targets.length === 0) return false;
  return targets.includes(email.trim().toLowerCase());
}

/** Every configured super-admin address, normalized and deduped (M4-02: abuse report e-mails). */
export function superAdminEmails(
  superAdminEmail: string | undefined = process.env.SUPERADMIN_EMAIL
): string[] {
  return [
    ...new Set(
      (superAdminEmail ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}
