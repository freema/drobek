/**
 * The sign-in provider contract (NSO-348): the `auth.provider` /
 * `auth.signedIn` slot schemas, `compose` (a slot host deriving its config,
 * confirm rules and secrets from contributions) and the method a session
 * signed in with.
 */
import { describe, expect, it } from 'vitest';
import { FakeRedis } from '@drobek/auth';
import { z } from 'zod';
import { authIdentitySchema, authProviderSchema, authSignedInObserverSchema, defineAuthProvider } from './auth-provider.js';
import { defineModule } from './contract.js';
import { createEndUserSession, loadEndUserSession, parseEndUserSession } from './principal.js';
import { ModuleLoadError, checkModuleSet, composeModule, validateModule } from './registry.js';
import { createModuleTestContext } from './testing.js';

const provider = defineAuthProvider({
  id: 'oidc',
  label: 'Company SSO',
  configSchema: z.strictObject({ issuer: z.url(), clientId: z.string() }),
  identityFields: ['issuer', 'clientId'],
  secrets: [{ name: 'OIDC_CLIENT_SECRET', description: 'client secret', env: 'AUTH_OIDC_CLIENT_SECRET' }],
  begin: async () => ({ url: 'https://idp.example/authorize' }),
  callback: async () => ({ subject: 's', email: 'a@b.cz', emailVerified: true }),
});

const issuesOf = (value: unknown) => {
  const r = authProviderSchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('authProviderSchema', () => {
  it('accepts a well-formed provider and keeps its functions', () => {
    const r = authProviderSchema.safeParse(provider);
    expect(r.success).toBe(true);
    expect(typeof (r.data as typeof provider).begin).toBe('function');
    expect((r.data as typeof provider).configSchema).toBe(provider.configSchema);
  });

  it.each([
    [{ id: 'email' }, /e-mail code/],
    [{ id: 'Oidc' }, /id must be/],
    [{ id: 'o' }, /id must be/],
    [{ label: ' SSO' }, /one trimmed line/],
    [{ label: 'a\nb' }, /one trimmed line/],
    [{ configSchema: z.string() }, /zod object schema/],
    [{ configSchema: z.strictObject({ enabled: z.boolean() }) }, /may not declare `enabled`/],
    [{ identityFields: ['tenant'] }, /does not declare/],
    [{ secrets: [{ name: 'CLIENT_SECRET', description: 'x' }] }, /start with "OIDC_"/],
    [{ secrets: [{ name: 'OIDC_X', description: 'x', env: 'OIDC_X' }] }, /AUTH_OIDC_/],
    [{ secrets: [{ name: 'OIDC_X', description: 'x' }, { name: 'OIDC_X', description: 'y' }] }, /declared twice/],
    [{ configDefaults: { issuer: 'not a url' } }, /configDefaults/],
    [{ begin: 'nope' }, /begin must be a function/],
  ])('refuses %j', (patch, message) => {
    expect(issuesOf({ ...provider, ...patch }).join(' | ')).toMatch(message);
  });

  it('the observer and identity schemas', () => {
    expect(authSignedInObserverSchema.safeParse({ id: 'crm-sync', onSignIn: () => undefined }).success).toBe(true);
    expect(authSignedInObserverSchema.safeParse({ id: 'CRM', onSignIn: () => undefined }).success).toBe(false);
    expect(authSignedInObserverSchema.safeParse({ id: 'crm' }).success).toBe(false);
    expect(authIdentitySchema.parse({ subject: 's-1', email: ' Ana@Example.COM ', emailVerified: true })).toEqual({ subject: 's-1', email: 'ana@example.com', emailVerified: true });
    expect(authIdentitySchema.safeParse({ subject: 'a\u0000b', email: 'a@b.cz', emailVerified: true }).success).toBe(false);
    expect(authIdentitySchema.safeParse({ subject: 'x'.repeat(256), email: 'a@b.cz', emailVerified: true }).success).toBe(false);
    expect(authIdentitySchema.safeParse({ subject: 's', email: 'a@b.cz', emailVerified: 'yes' }).success).toBe(false);
    expect(authIdentitySchema.safeParse({ subject: 's', email: 'nope', emailVerified: true }).success).toBe(false);
  });
});

describe('compose — a slot host built from its contributions', () => {
  const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' } };
  const host = defineModule<{ names: string[] }>({
    ...base,
    name: 'host',
    configSchema: z.object({ names: z.array(z.string()) }),
    configDefaults: { names: [] },
    slots: { 'host.item': { schema: z.object({ name: z.string() }), unique: 'name', description: 'items' } },
    compose: ({ contributions }) => {
      const items = contributions<{ name: string }>('host.item');
      const known = items.map((i) => i.name);
      return {
        configSchema: z.object({ names: z.array(z.enum(known.length ? (known as [string, ...string[]]) : ['_'])) }),
        configDefaults: { names: [] },
        secrets: items.map((i) => ({ name: `${i.name.toUpperCase()}_KEY`, description: i.name })),
      };
    },
  });
  const item = (name: string) => defineModule<Record<string, never>>({ ...base, name, configSchema: z.object({}), configDefaults: {}, contributes: { 'host.item': { name } } });

  it('checkModuleSet composes the host; the test kit composes from `contributions`', () => {
    const [composed] = checkModuleSet([host, item('alpha'), item('beta')], {});
    expect(composed.configSchema.safeParse({ names: ['alpha', 'beta'] }).success).toBe(true);
    expect(composed.configSchema.safeParse({ names: ['gamma'] }).success).toBe(false);
    expect(composed.secrets!.map((s) => s.name)).toEqual(['ALPHA_KEY', 'BETA_KEY']);
    expect(Object.isFrozen(composed)).toBe(true);
    const t = createModuleTestContext(host, { contributions: { 'host.item': [{ name: 'alpha' }] } });
    expect(t.module.secrets!.map((s) => s.name)).toEqual(['ALPHA_KEY']);
  });

  it('refuses parts it may not replace, a bad schema, defaults that fail, bad secret names, a throw', () => {
    const none = () => [] as never[];
    const run = (compose: unknown) => () => composeModule({ ...host, compose } as never, none);
    expect(run(() => ({ routes: () => undefined }))).toThrow(/may not replace "routes"/);
    expect(run(() => ({ configSchema: {} }))).toThrow(/must be a zod schema/);
    expect(run(() => ({ configDefaults: { names: 'x' } }))).toThrow(/configDefaults do not pass/);
    expect(run(() => ({ secrets: [{ name: 'lower', description: 'x' }] }))).toThrow(/UPPER_SNAKE/);
    expect(run(() => ({ secrets: [{ name: 'A_B', description: 'x' }, { name: 'A_B', description: 'y' }] }))).toThrow(/declared twice/);
    expect(run(() => ({ confirmRequired: 'x' }))).toThrow(/must be a function/);
    expect(run(() => null)).toThrow(/object of module parts/);
    expect(run(() => {
      throw new Error('nope');
    })).toThrow(ModuleLoadError);
    const plain = item('alpha');
    expect(composeModule(plain, none)).toBe(plain);
  });

  it('validateModule: compose must be a function of a slot host', () => {
    expect(() => validateModule({ ...host, compose: 'x' } as never)).toThrow(/compose must be a function/);
    expect(() => validateModule({ ...item('alpha'), compose: () => ({}) } as never)).toThrow(/compose needs slots/);
  });
});

describe('the sign-in method of a session', () => {
  it('is kept when valid, refused when not; old sessions without it still parse', async () => {
    const redis = new FakeRedis();
    const token = await createEndUserSession(redis, 'app_1', { id: 'eu_1', email: 'a@b.cz', role: 'user', provider: 'oidc' });
    expect(await loadEndUserSession(redis, 'app_1', token)).toEqual({ id: 'eu_1', email: 'a@b.cz', role: 'user', epoch: 0, provider: 'oidc' });
    await expect(createEndUserSession(redis, 'app_1', { id: 'eu_1', email: 'a@b.cz', role: 'user', provider: 'Bad Id' })).rejects.toThrow(/invalid session provider/);
    expect(parseEndUserSession(JSON.stringify({ id: 'eu_1', email: 'a@b.cz', role: 'user', epoch: 0 }))).toEqual({ id: 'eu_1', email: 'a@b.cz', role: 'user', epoch: 0 });
    expect(parseEndUserSession(JSON.stringify({ id: 'eu_1', email: 'a@b.cz', role: 'user', epoch: 0, provider: 7 }))).toBeNull();
    expect(parseEndUserSession(JSON.stringify({ id: 'eu_1', email: 'a@b.cz', role: 'user', epoch: 0, provider: '../x' }))).toBeNull();
  });
});
