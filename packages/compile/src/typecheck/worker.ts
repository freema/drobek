/**
 * The typecheck worker thread: the TypeScript checker runs here so a
 * check never blocks the server's event loop. It receives the SDK
 * declarations once (workerData) and then one message per check.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { typecheckApp, type TypecheckSdk } from './check.js';

export interface WorkerJob {
  id: number;
  files: Record<string, string>;
  maxFindings: number;
}

export type WorkerReply =
  | { id: number; ok: true; findings: Awaited<ReturnType<typeof typecheckApp>>['findings']; total: number }
  | { id: number; ok: false; error: string };

const sdk = workerData as TypecheckSdk;

parentPort?.on('message', (job: WorkerJob) => {
  typecheckApp(job.files, sdk, job.maxFindings).then(
    (out) => parentPort?.postMessage({ id: job.id, ok: true, findings: out.findings, total: out.total } satisfies WorkerReply),
    (err: unknown) =>
      parentPort?.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerReply)
  );
});
