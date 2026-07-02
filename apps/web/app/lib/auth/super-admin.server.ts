/**
 * SUPERADMIN_EMAIL bootstrap — a computed GLOBAL flag, NOT a memberships role
 * and NOT a DB column (see packages/db/src/schema.ts header). Empty env means
 * nobody is super-admin.
 */
export function isSuperAdmin(
  email: string,
  superAdminEmail: string | undefined = process.env.SUPERADMIN_EMAIL
): boolean {
  const target = (superAdminEmail ?? '').trim().toLowerCase();
  if (!target) return false;
  return email.trim().toLowerCase() === target;
}
