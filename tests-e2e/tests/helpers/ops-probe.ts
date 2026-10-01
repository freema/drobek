import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';

/**
 * The operator-only e2e fixture `opsprobe`
 * (tests-e2e/fixtures/drobek-module-ops-probe), installed in both e2e stacks:
 * its error reporter `capture` POSTs every report to proxy-echo, which keeps
 * them; its server job `probe` fails once with the message a spec armed there.
 * proxy-echo publishes no port, so the helpers talk to it from inside its
 * container (`docker compose exec` — the dev stack, or the image flow's
 * project that scripts/e2e-image.sh exports). Not a spec file.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CAPTURE = 'http://127.0.0.1:8099/opsprobe';
export const OPS_MODULE = 'opsprobe';
export const OPS_JOB = 'probe';

/** One report the reporter delivered: the event exactly as the server sent it. */
export interface OpsReport {
  received_at: string;
  event: Record<string, unknown> & {
    message: string;
    error?: { name: string; message: string; stack?: string };
    context: Record<string, unknown>;
  };
}

function compose(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('docker', ['compose', ...args], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

/** A fetch against the capture endpoint from inside proxy-echo; the answer as JSON. */
function capture(method: 'GET' | 'POST', path: string, body?: unknown): Record<string, unknown> {
  const script = `fetch(${JSON.stringify(`${CAPTURE}${path}`)}, { method: ${JSON.stringify(method)}, body: process.env.OPS_BODY || undefined }).then((r) => r.text()).then((t) => process.stdout.write(t))`;
  const out = compose(['exec', '-T', '-e', `OPS_BODY=${body === undefined ? '' : JSON.stringify(body)}`, 'proxy-echo', 'node', '-e', script]);
  const json = JSON.parse(out) as Record<string, unknown>;
  if (path === '/reports' && method === 'GET' && !Array.isArray(json.reports)) {
    throw new Error('proxy-echo answered without the report capture: restart it to load tests-e2e/proxy-echo.mjs (docker compose restart proxy-echo)');
  }
  return json;
}

/** An env value of the running drobek container ('' when unset). */
export function drobekEnv(name: string): string {
  return compose(['exec', '-T', 'drobek', 'sh', '-c', `printf %s "$${name}"`]);
}

/** Every report the capture holds, oldest first. */
export function opsReports(): OpsReport[] {
  return capture('GET', '/reports').reports as OpsReport[];
}

/** Arm the fixture's server job to throw `message` on its next run, and make that run due now. */
export async function failNextJobRun(message: string): Promise<void> {
  capture('POST', '/job', { fail: message });
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6391', { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  try {
    await redis.del(`drobek:modjob:${OPS_MODULE}:${OPS_JOB}`);
  } finally {
    redis.disconnect();
  }
}

/** The top-level fields of a reported event (ErrorReportEvent) — nothing about the request, its headers, cookies or body. */
export const REPORT_FIELDS = ['level', 'message', 'error', 'context', 'release', 'environment', 'timestamp', 'fingerprint'];
