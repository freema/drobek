import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LIST,
  actorKindForSurface,
} from './actor.js';

describe('actorKindForSurface (PHY-85 actor_kind resolution)', () => {
  it('an MCP tool call is attributed to the agent', () => {
    expect(actorKindForSurface('mcp')).toBe('agent');
  });

  it('a dashboard/web action is attributed to the user', () => {
    expect(actorKindForSurface('web')).toBe('user');
  });

  it('is total over the surface union (only the two surfaces)', () => {
    const surfaces = ['mcp', 'web'] as const;
    const kinds = surfaces.map(actorKindForSurface);
    expect(new Set(kinds)).toEqual(new Set(['agent', 'user']));
  });
});

describe('audit action vocabulary', () => {
  it('exposes the PHY-85 surfaced actions', () => {
    expect(AUDIT_ACTIONS).toMatchObject({
      appCreate: 'app.create',
      deployActivate: 'deploy.activate',
      deployRollback: 'deploy.rollback',
      memberInvite: 'member.invite',
      memberAccept: 'member.accept',
      memberRoleChange: 'member.role_change',
    });
  });

  it('the action list has no duplicates', () => {
    expect(new Set(AUDIT_ACTION_LIST).size).toBe(AUDIT_ACTION_LIST.length);
  });
});
