/**
 * Audit writes moved to the neutral @drobek/audit package (PHY-85) so
 * @drobek/tenancy can also write without a @drobek/deploy → cycle. This module
 * re-exports the write helper + the actor vocabulary for the deploy call sites
 * (worker deploy.activate, rollback) and downstream consumers that import from
 * the @drobek/deploy barrel / the /rollback subpath.
 */
export {
  writeAudit,
  actorKindForSurface,
  AUDIT_ACTIONS,
  AUDIT_SUBJECT_TYPES,
  type AuditEntry,
  type AuditActorKind,
  type AuditSurface,
} from '@drobek/audit';
