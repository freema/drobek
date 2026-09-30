/**
 * The module as a server loads it: next to `auth`, its provider composes
 * into the auth config (`providers.oidc`) and secrets; without `auth` the
 * server refuses to start.
 */
import { describe, expect, it } from 'vitest';
import { checkModuleSet, type AnyModule } from '@drobek/modules';
import auth from 'drobek-module-auth';
import oidc from './index.js';

const composedAuth = (): AnyModule => checkModuleSet([auth, oidc] as AnyModule[], {}).find((m) => m.name === 'auth')!;

describe('the oidc module', () => {
  it('contributes the auth.provider "oidc": config, defaults and the client secret land in the auth module', () => {
    const a = composedAuth();
    const defaults = a.configDefaults as { providers: Record<string, unknown> };
    expect(defaults.providers.oidc).toEqual({ scopes: ['openid', 'email', 'profile'], trustEmail: false, label: 'Company account', enabled: false });
    expect(a.secrets).toEqual([expect.objectContaining({ name: 'OIDC_CLIENT_SECRET' })]);

    const on = (entry: Record<string, unknown>) =>
      a.configSchema.safeParse({ ...defaults, providers: { emailCode: { enabled: true }, oidc: { ...(defaults.providers.oidc as object), enabled: true, ...entry } } });
    expect(on({ issuer: 'https://login.microsoftonline.com/0f1e/v2.0', clientId: 'abc', prompt: 'select_account', claims: { email: 'preferred_username' } }).success).toBe(true);
    // Everything optional: the operator's AUTH_OIDC_ISSUER / _CLIENT_ID may stand in.
    expect(on({}).success).toBe(true);
    expect(on({ issuer: 'https://idp.example/?tenant=x' }).success).toBe(false);
    expect(on({ issuer: 'ftp://idp.example' }).success).toBe(false);
    expect(on({ scopes: ['email'] }).success).toBe(false);
    expect(on({ label: 'Two\nlines' }).success).toBe(false);
    expect(on({ secret: 'x' }).success).toBe(false);
  });

  it('changing who may claim an address (issuer, clientId, trustEmail, claims) waits for the owner; the label does not', async () => {
    const confirm = composedAuth().confirmRequired!;
    const entry = { enabled: true, issuer: 'https://idp.example', clientId: 'abc', trustEmail: false, label: 'Acme' };
    const cfg = (oidcEntry: Record<string, unknown>) => ({ allow: { emails: [], domains: [], anyone: false }, adminEmails: [], providers: { emailCode: { enabled: true }, oidc: oidcEntry } });
    const items = async (change: Record<string, unknown>) => (await confirm(cfg(entry), cfg({ ...entry, ...change }), {} as never)).map(String);
    expect(await items({ trustEmail: true })).toEqual([expect.stringMatching(/^providers\.oidc\.trustEmail: false → true/)]);
    expect(await items({ claims: { email: 'upn' } })).toEqual([expect.stringMatching(/^providers\.oidc\.claims: unset → /)]);
    expect(await items({ label: 'Acme SSO', prompt: 'login' })).toEqual([]);
  });

  it('has no config of its own and requires auth', () => {
    expect(oidc.configSchema.safeParse({}).success).toBe(true);
    expect(oidc.configSchema.safeParse({ issuer: 'https://idp.example' }).success).toBe(false);
    expect(() => checkModuleSet([oidc] as AnyModule[], {})).toThrow(/auth/);
    expect(oidc.limits).toEqual([expect.objectContaining({ env: 'OIDC_DISCOVERY_CACHE_SEC', default: 3600 })]);
    expect(oidc.errors?.map((e) => e.code)).toEqual(['oidc_discovery_failed', 'oidc_token_invalid']);
  });

  it('the skill stays within the skill format (the full gate is @drobek/skills-check)', () => {
    expect(oidc.skill.markdown.split('\n').length).toBeLessThanOrEqual(150);
    expect(oidc.skill.useWhen).toMatch(/^people should sign in/);
  });
});
