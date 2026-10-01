/**
 * drobek-module-errorsink — an error reporter as an external module: its
 * `errors.reporter` contribution `errorsink` needs ERRORSINK_TOKEN from the
 * server env and collects every event in an inbox on globalThis (the test
 * reads it there). An event whose message contains `explode` throws with the
 * token in the error text; one containing `hang` waits until the server
 * aborts the delivery. No skill: an operator-only module, never listed for
 * agents or app owners.
 */
import { defineErrorReporter, defineModule, z } from '@drobek/modules';

const INBOX = Symbol.for('drobek.test.errorsink.inbox');

export default defineModule({
  name: 'errorsink',
  version: '1.0.0',
  contract: '^1.2',
  configSchema: z.object({}),
  configDefaults: {},
  contributes: {
    'errors.reporter': defineErrorReporter({
      apiVersion: 1,
      id: 'errorsink',
      label: 'Error sink',
      secrets: ['ERRORSINK_TOKEN'],
      async report(event, { secrets, signal }) {
        if (event.message.includes('explode')) throw new Error(`sink refused token ${secrets.ERRORSINK_TOKEN}`);
        if (event.message.includes('hang')) {
          await new Promise((resolve) => signal.addEventListener('abort', resolve));
          return;
        }
        (globalThis[INBOX] ??= []).push({ event, token: secrets.ERRORSINK_TOKEN });
      },
    }),
  },
});
