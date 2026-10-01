/**
 * The `email.transport` slot: the contribution schema, the selection by
 * EMAIL_TRANSPORT and the start refusals, with the mailrelay fixture loaded
 * from DROBEK_MODULES_DIR the way an operator installs it. A stand-in for the
 * built-in `email` hosts the slot with the real schema, `operatorOnly` like
 * the real one: mailrelay has no skill, an operator-only module.
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@drobek/core';
import { installedEmailTransportId, resetEmailTransportForTests, sendEmail } from '@drobek/email';
import { defineModule, type AnyModule } from './contract.js';
import { EMAIL_TRANSPORT_SLOT, defineEmailTransport, emailTransportSchema, installModuleEmailTransport, selectEmailTransport } from './email-transport-slot.js';
import { checkModuleSet, loadModuleSet } from './registry.js';
import { loadModuleRuntime } from './runtime.js';
import { MAILRELAY_FIXTURE, installDirModule, tempModulesDir } from './test/modules-dir.js';

const TOKEN = 'mr_test_fake_token_0123456789';
const OUTBOX = Symbol.for('drobek.test.mailrelay.outbox');
type Outbox = { message: { from: { name: string; address: string }; to: string; subject: string; text: string; html: string; replyTo?: string }; token: string }[];
const outbox = (): Outbox => ((globalThis as Record<symbol, unknown>)[OUTBOX] ??= []) as Outbox;

const emailHost = defineModule({
  name: 'email',
  version: '1.0.0',
  contract: '^1.1',
  skill: { useWhen: 'a test needs the transport slot', markdown: '# email\n' },
  configSchema: z.object({}),
  configDefaults: {},
  slots: { [EMAIL_TRANSPORT_SLOT]: { schema: emailTransportSchema, unique: 'id', description: 'e-mail transports', operatorOnly: true } },
});

function transportModule(name: string, transport: Record<string, unknown>): AnyModule {
  return defineModule({
    name,
    version: '1.0.0',
    contract: '^1.2',
    skill: { useWhen: 'a test', markdown: `# ${name}\n` },
    configSchema: z.object({}),
    configDefaults: {},
    requires: ['email'],
    contributes: { [EMAIL_TRANSPORT_SLOT]: transport },
  });
}

const builtins = async (pkg: string) => {
  if (pkg === 'drobek-module-email') return emailHost;
  throw new Error(`Cannot find package '${pkg}'`);
};

const dirs: string[] = [];
async function loadWithRelay(env: Record<string, string>) {
  const dir = tempModulesDir();
  dirs.push(dir);
  installDirModule(dir, { name: 'mailrelay', from: MAILRELAY_FIXTURE });
  return loadModuleSet({ NODE_ENV: 'test', ...env }, { modulesDir: dir, log: noopLogger, importer: builtins });
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetEmailTransportForTests();
  outbox().length = 0;
});

describe('the email.transport contribution schema', () => {
  const ok = { id: 'postmark', label: 'Postmark', secrets: ['POSTMARK_TOKEN'], send: async () => {} };

  it('accepts a transport with or without apiVersion 1', () => {
    expect(emailTransportSchema.safeParse(ok).success).toBe(true);
    expect(emailTransportSchema.safeParse({ ...ok, apiVersion: 1 }).success).toBe(true);
    expect(emailTransportSchema.safeParse(defineEmailTransport({ id: 'relay', label: 'Relay', send: async () => {} })).success).toBe(true);
  });

  it('refuses the built-in ids, a bad id, apiVersion, label, secret names and a missing send', () => {
    const issue = (v: unknown) => {
      const r = emailTransportSchema.safeParse(v);
      return r.success ? null : r.error.issues.map((i) => i.message).join('; ');
    };
    expect(issue({ ...ok, id: 'smtp' })).toMatch(/built-in transports/);
    expect(issue({ ...ok, id: 'resend' })).toMatch(/built-in transports/);
    expect(issue({ ...ok, id: 'Post-Mark' })).toMatch(/lowercase letters and digits/);
    expect(issue({ ...ok, apiVersion: 2 })).toMatch(/not an e-mail transport API this server implements \(1\)/);
    expect(issue({ ...ok, label: 'Two\nlines' })).toMatch(/one trimmed line/);
    expect(issue({ ...ok, secrets: ['postmark_token'] })).toMatch(/UPPER_SNAKE/);
    expect(issue({ ...ok, secrets: ['A_B', 'A_B'] })).toMatch(/twice/);
    expect(issue({ ...ok, send: 'nope' })).toMatch(/send must be a function/);
  });
});

describe('selection by EMAIL_TRANSPORT', () => {
  it('smtp / resend (or unset) select no module transport and uninstall a previous one', async () => {
    const { modules } = await loadWithRelay({ DROBEK_MODULES: 'email,mailrelay' });
    for (const EMAIL_TRANSPORT of [undefined, 'smtp', 'resend']) {
      expect(selectEmailTransport(modules, { EMAIL_TRANSPORT })).toBeNull();
    }
    installModuleEmailTransport(modules, { EMAIL_TRANSPORT: 'mailrelay', MAILRELAY_TOKEN: TOKEN });
    expect(installedEmailTransportId()).toBe('mailrelay');
    installModuleEmailTransport(modules, {});
    expect(installedEmailTransportId()).toBeNull();
  });

  it('EMAIL_TRANSPORT=mailrelay: the dir module transport is installed and carries sendEmail, with the env token', async () => {
    const env = { EMAIL_TRANSPORT: 'mailrelay', MAILRELAY_TOKEN: TOKEN, EMAIL_FROM: 'drobek <no-reply@drobek.app>' };
    const { modules } = await loadWithRelay({ ...env, DROBEK_MODULES: 'email,mailrelay' });
    expect(selectEmailTransport(modules, env)).toMatchObject({ module: 'mailrelay', transport: { id: 'mailrelay' } });
    const infos: unknown[] = [];
    installModuleEmailTransport(modules, env, { ...noopLogger, info: (...a: unknown[]) => void infos.push(a) } as never);
    expect(JSON.stringify(infos)).not.toContain(TOKEN);

    await expect(sendEmail({ to: 'ana@example.com', subject: 'Hi', text: 't', html: '<p>t</p>', replyTo: 'r@example.org' }, env)).resolves.toBe('sent');
    expect(outbox()).toEqual([
      {
        message: { from: { name: 'drobek', address: 'no-reply@drobek.app' }, to: 'ana@example.com', subject: 'Hi', text: 't', html: '<p>t</p>', replyTo: 'r@example.org' },
        token: TOKEN,
      },
    ]);

    const err = (await sendEmail({ to: 'x@fail.example', subject: 's', text: 't', html: 'h' }, env).catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ name: 'EmailSendError', code: 'unavailable' });
    expect(err.message).toBe('e-mail transport "mailrelay" failed (Error: relay refused token [redacted])');
  });

  it('refuses the start without the module that contributes the id, naming what is available (never the env value)', async () => {
    const env = { EMAIL_TRANSPORT: 'mailrelay', MAILRELAY_TOKEN: TOKEN, DROBEK_MIGRATE_ON_START: '0' };
    await expect(loadModuleRuntime({ env, modules: [emailHost], skillsDir: null, log: noopLogger })).rejects.toThrow(
      /EMAIL_TRANSPORT names no e-mail transport of the active modules \(built in: smtp, resend; from modules: none\) — add the module that contributes it to DROBEK_MODULES, or set EMAIL_TRANSPORT=smtp/
    );
    expect(() => selectEmailTransport([], env)).toThrow(/together with "email" \(it hosts the email\.transport slot\)/);
  });

  it('refuses the start on an unknown id, listing the module transports', async () => {
    const { modules } = await loadWithRelay({ DROBEK_MODULES: 'email,mailrelay' });
    const run = () => selectEmailTransport(modules, { EMAIL_TRANSPORT: 'postmark' });
    expect(run).toThrow(/from modules: mailrelay\)/);
    expect(run).not.toThrow(/postmark/);
  });

  it('refuses the start when the env lacks a declared secret', async () => {
    const { modules } = await loadWithRelay({ DROBEK_MODULES: 'email,mailrelay' });
    expect(() => installModuleEmailTransport(modules, { EMAIL_TRANSPORT: 'mailrelay', MAILRELAY_TOKEN: '  ' })).toThrow(
      /the e-mail transport "mailrelay" \(module "mailrelay"\) needs MAILRELAY_TOKEN in the server env/
    );
    expect(installedEmailTransportId()).toBeNull();
  });

  it('refuses a module that would override smtp or resend, and two transports with one id', () => {
    for (const id of ['smtp', 'resend']) {
      expect(() => checkModuleSet([emailHost, transportModule('fake', { id, label: 'Fake', send: async () => {} })], {})).toThrow(
        new RegExp(`module "fake": its contribution to the slot "email\\.transport" \\(module "email"\\) does not pass the slot's schema — id: id "smtp" and "resend" are the built-in transports`)
      );
    }
    const t = { id: 'relay', label: 'Relay', send: async () => {} };
    expect(() => checkModuleSet([emailHost, transportModule('one', t), transportModule('two', t)], {})).toThrow(
      /modules "one" and "two" both contribute id "relay" to the slot "email\.transport"/
    );
  });

  it('refuses a transport contribution while the email module is not active', async () => {
    await expect(loadWithRelay({ DROBEK_MODULES: 'mailrelay' })).rejects.toThrow(/module "mailrelay" requires the module "email"/);
  });
});

describe('a transport module without a skill (operator-only)', () => {
  it('loads from DROBEK_MODULES_DIR; agents never see it, the summary marks it for operators', async () => {
    const { modules, origins } = await loadWithRelay({ DROBEK_MODULES: 'email,mailrelay' });
    expect(modules[1]).not.toHaveProperty('skill');
    const rt = await loadModuleRuntime({ env: { DROBEK_MIGRATE_ON_START: '0' }, modules, origins, skillsDir: null, log: noopLogger });
    expect(rt.skillList().map((s) => s.name)).toEqual(['email']);
    expect(rt.skillInfo('mailrelay')).toBeNull();
    expect(rt.summary()).toEqual([
      { name: 'email', version: '1.0.0', source: 'builtin', contract: '^1.1' },
      { name: 'mailrelay', version: '1.0.0', source: 'dir', contract: '^1.2', operatorOnly: true },
    ]);
  });

  it('is refused by a host whose email.transport slot is not operatorOnly', async () => {
    const host = defineModule({ ...emailHost, slots: { [EMAIL_TRANSPORT_SLOT]: { schema: emailTransportSchema, unique: 'id', description: 'e-mail transports' } } });
    const dir = tempModulesDir();
    dirs.push(dir);
    installDirModule(dir, { name: 'mailrelay', from: MAILRELAY_FIXTURE });
    const importer = async (pkg: string) => (pkg === 'drobek-module-email' ? host : Promise.reject(new Error(`Cannot find package '${pkg}'`)));
    await expect(loadModuleSet({ DROBEK_MODULES: 'email,mailrelay' }, { modulesDir: dir, log: noopLogger, importer })).rejects.toThrow(
      /module "mailrelay" has no skill, but contributes to the slot "email\.transport" \(module "email"\), which reaches apps/
    );
  });
});
