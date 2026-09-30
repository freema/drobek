import { describe, expect, it } from 'vitest';
import { defineAuthProvider, z } from '@drobek/modules';
import { AUTH_CONFIG_DEFAULTS, authConfigSchema, composeAuthConfig, confirmRequiredFor, type AuthConfig } from './config.js';

type Node = { title?: string; description?: string; properties?: Record<string, Node>; anyOf?: Node[] };

function at(schema: unknown, path: string): Node {
  let cur = schema as Node;
  for (const seg of path.split('.')) {
    const props = cur.properties ?? cur.anyOf?.find((b) => b.properties)?.properties;
    cur = props![seg];
  }
  return cur;
}

const provider = defineAuthProvider({
  apiVersion: 2,
  id: 'idp',
  label: 'Test IdP',
  configSchema: z.strictObject({ issuer: z.url(), clientId: z.string().min(1) }),
  identityFields: ['issuer', 'clientId'],
  async begin() {
    return { url: 'https://idp.example.com/authorize' };
  },
  async callback() {
    return { issuer: 'https://idp.example.com', subject: 's', email: 'a@example.com', emailVerified: true };
  },
});

describe('the auth config schema labels the dashboard form', () => {
  const json = z.toJSONSchema(authConfigSchema, { unrepresentable: 'any', io: 'input' });

  it('gives every allowlist setting a title and a description of what an empty list means', () => {
    for (const path of ['allow.emails', 'allow.domains', 'adminEmails']) {
      const node = at(json, path);
      expect(node.title, path).toBeTruthy();
      expect(node.description, path).toMatch(/empty list/);
    }
    expect(at(json, 'allow.emails').title).toBe('Allowed e-mail addresses');
    expect(at(json, 'allow.anyone').description).toMatch(/confirmation/);
    expect(at(json, 'providers.emailCode').title).toBe('E-mail code');
  });

  it('labels a provider entry by the provider and its switches', () => {
    const composed = z.toJSONSchema(composeAuthConfig([provider]).configSchema as z.ZodType, { unrepresentable: 'any', io: 'input' });
    expect(at(composed, 'providers.idp').title).toBe('Test IdP');
    expect(at(composed, 'providers.idp.enabled').description).toMatch(/Test IdP/);
    expect(at(composed, 'providers.idp.relinkByEmail').title).toBeTruthy();
  });
});

describe('labels change neither validation nor what waits for confirmation', () => {
  it('the defaults still validate: empty lists, anyone off, the e-mail code on', () => {
    expect(authConfigSchema.parse(AUTH_CONFIG_DEFAULTS)).toEqual(AUTH_CONFIG_DEFAULTS);
  });

  it('opening sign-in to anyone and enabling a provider still wait; turning things off does not', () => {
    const parts = composeAuthConfig([provider]);
    const before = parts.configDefaults as AuthConfig;
    const confirm = confirmRequiredFor([provider]);
    const open: AuthConfig = { ...before, allow: { ...before.allow, anyone: true } };
    expect(confirm(before, open)).toHaveLength(1);
    const enabled: AuthConfig = {
      ...before,
      providers: { ...before.providers, idp: { enabled: true, issuer: 'https://idp.example.com', clientId: 'c' } },
    };
    expect(confirm(before, enabled)).toHaveLength(1);
    expect(confirm(open, before)).toEqual([]);
    expect(confirm(enabled, before)).toEqual([]);
  });
});
