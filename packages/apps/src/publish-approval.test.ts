import { describe, expect, it } from 'vitest';
import {
  operatorContact,
  operatorEmails,
  publishApprovalConfigError,
  publishApprovalMode,
  publishBlockedMessage,
  publishBlockedNotice,
  publishNotApprovedMessage,
  publishNotifyMode,
} from './publish-approval.js';

describe('publishing config and messages', () => {
  it('defaults to open; approval only when asked; an unknown value fails closed', () => {
    expect(publishApprovalMode({})).toBe('open');
    expect(publishApprovalMode({ PUBLISH_APPROVAL: ' Open ' })).toBe('open');
    expect(publishApprovalMode({ PUBLISH_APPROVAL: 'approval' })).toBe('approval');
    expect(publishApprovalMode({ PUBLISH_APPROVAL: 'yes' })).toBe('approval');
  });

  it('the contact is OPERATOR_EMAIL, else the first super-admin', () => {
    expect(operatorContact({})).toBeNull();
    expect(operatorContact({ SUPERADMIN_EMAIL: ' Boss@X.test , two@x.test' })).toBe('boss@x.test');
    expect(operatorEmails({ SUPERADMIN_EMAIL: 'boss@x.test,two@x.test' })).toEqual(['boss@x.test', 'two@x.test']);
    expect(operatorEmails({ SUPERADMIN_EMAIL: 'boss@x.test', OPERATOR_EMAIL: 'Ops@X.test' })).toEqual(['ops@x.test']);
  });

  it('refuses to start on an invalid mode, a bad OPERATOR_EMAIL or approval without a super-admin', () => {
    expect(publishApprovalConfigError({})).toBeNull();
    expect(publishApprovalConfigError({ PUBLISH_APPROVAL: 'open' })).toBeNull();
    expect(publishApprovalConfigError({ PUBLISH_APPROVAL: 'strict' })).toMatch(/PUBLISH_APPROVAL must be "open" or "approval" \(got "strict"\)/);
    expect(publishApprovalConfigError({ OPERATOR_EMAIL: 'a@x.test,b@x.test' })).toMatch(/OPERATOR_EMAIL must be one e-mail address/);
    expect(publishApprovalConfigError({ PUBLISH_APPROVAL: 'approval' })).toMatch(/set SUPERADMIN_EMAIL/);
    expect(publishApprovalConfigError({ PUBLISH_APPROVAL: 'approval', OPERATOR_EMAIL: 'ops@x.test' })).toMatch(/set SUPERADMIN_EMAIL/);
    expect(publishApprovalConfigError({ PUBLISH_APPROVAL: 'approval', SUPERADMIN_EMAIL: 'boss@x.test' })).toBeNull();
  });

  it('PUBLISH_NOTIFY is off by default; first / every when asked; anything else stops the start', () => {
    expect(publishNotifyMode({})).toBe('off');
    expect(publishNotifyMode({ PUBLISH_NOTIFY: ' First ' })).toBe('first');
    expect(publishNotifyMode({ PUBLISH_NOTIFY: 'every' })).toBe('every');
    for (const v of ['off', 'first', 'every', 'EVERY', '']) expect(publishApprovalConfigError({ PUBLISH_NOTIFY: v })).toBeNull();
    expect(publishApprovalConfigError({ PUBLISH_NOTIFY: 'always' })).toMatch(/PUBLISH_NOTIFY must be "off", "first" or "every" \(got "always"\)/);
  });

  it('the blocked message and notice name the operator', () => {
    expect(publishBlockedMessage('ops@x.test')).toBe(
      'Publishing from this workspace was turned off by the operator of this server (ops@x.test). Previews, versions and everything else keep working; live apps keep serving unless taken down.'
    );
    expect(publishBlockedMessage(null)).toMatch(/^Publishing from this workspace was turned off by the operator of this server\. /);
    expect(publishBlockedNotice('ops@x.test')).toBe('Publishing from this workspace was turned off by the operator (ops@x.test).');
  });

  it('the refusal names the contact and says a request was sent', () => {
    const m = publishNotApprovedMessage('ops@x.test');
    expect(m).toContain('needs approval from ops@x.test');
    expect(m).toContain('An approval request was sent to ops@x.test');
  });
});
