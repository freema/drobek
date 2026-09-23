/**
 * The "taken down by the operator" banner for an app page (M4-02, NSO-293).
 * Client-safe (no server imports): feed it `lockedByAdminView(appId)` from
 * the loader (app-api.server.ts) — `null` renders nothing.
 */
export interface LockedByAdminView {
  /** The takedown category (phishing, malware, …). */
  reason: string;
  /** Its human label. */
  label: string;
}

export function LockedByAdminNotice({ locked }: { locked: LockedByAdminView | null | undefined }) {
  if (!locked) return null;
  return (
    <p
      role="alert"
      data-testid="app-locked-by-admin"
      data-reason={locked.reason}
      style={{
        background: '#fef2f2',
        border: '1px solid #fecaca',
        color: '#991b1b',
        padding: '0.7rem 0.95rem',
        borderRadius: '10px',
        margin: '1rem 0',
        fontSize: '0.92rem',
        lineHeight: 1.5,
      }}
    >
      <strong>Taken down by the operator</strong> ({locked.label.toLowerCase()}). The app is unpublished, every one of
      its addresses shows an “unavailable” page, and it cannot be changed, published or reconfigured until the operator
      restores it.
    </p>
  );
}
