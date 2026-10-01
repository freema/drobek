/**
 * drobek-module-mailrelay — an e-mail transport as an external module: its
 * `email.transport` contribution `mailrelay` needs MAILRELAY_TOKEN from the
 * server env and delivers into an outbox on globalThis (the test reads it
 * there). A message to an address at `fail.example` throws with the token
 * in the error text, which the server must redact.
 */
import { defineEmailTransport, defineModule, z } from '@drobek/modules';

const OUTBOX = Symbol.for('drobek.test.mailrelay.outbox');

export default defineModule({
  name: 'mailrelay',
  version: '1.0.0',
  contract: '^1.2',
  skill: { useWhen: 'a test needs an e-mail transport from a module', markdown: '# mailrelay\n' },
  configSchema: z.object({}),
  configDefaults: {},
  requires: ['email'],
  contributes: {
    'email.transport': defineEmailTransport({
      apiVersion: 1,
      id: 'mailrelay',
      label: 'Company relay',
      secrets: ['MAILRELAY_TOKEN'],
      async send(message, { secrets }) {
        if (message.to.endsWith('@fail.example')) throw new Error(`relay refused token ${secrets.MAILRELAY_TOKEN}`);
        (globalThis[OUTBOX] ??= []).push({ message, token: secrets.MAILRELAY_TOKEN });
      },
    }),
  },
});
