/**
 * Proxy audit actions (PHY-59). The audit_log `action` column is free text (open
 * vocabulary — see @drobek/audit), so these live here rather than mutating the
 * shared enum. Every upstream config mutation writes one row via writeAudit; the
 * plaintext secret is NEVER placed in audit meta.
 */
export const PROXY_AUDIT_ACTIONS = {
  upstreamCreate: 'proxy.upstream.create',
  upstreamDelete: 'proxy.upstream.delete',
} as const;

export type ProxyAuditAction =
  (typeof PROXY_AUDIT_ACTIONS)[keyof typeof PROXY_AUDIT_ACTIONS];

/** Subject type recorded for upstream audit rows. */
export const PROXY_SUBJECT_TYPE = 'upstream';
