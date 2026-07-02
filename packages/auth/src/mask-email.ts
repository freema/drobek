/** Masked e-mail for logs and UI (GDPR) — `ab***@domain.tld`. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain || !local) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}
