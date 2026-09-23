/**
 * GET /workspaces/:slug/apps/:appSlug/files/download?version=N — one version
 * as a ZIP (NSO-288): `<slug>-v<N>/source/…` (what the agent wrote) and
 * `<slug>-v<N>/built/…` (what the compiler produced). viewer+ (the same
 * people who can read the files in the Files tab); a resource route that
 * streams the archive (@drobek/apps versionZip) — blobs are read in small
 * batches, never the whole version at once.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { versionZip } from '@drobek/apps';
import { loadAppPage } from '../app-page.server.js';

function notFound(): Response {
  return new Response('not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<Response> {
  const { app } = await loadAppPage(request, params, 'viewer');
  const raw = new URL(request.url).searchParams.get('version');
  const number = Number(raw);
  if (!raw || !Number.isInteger(number) || number < 1) return notFound();
  const zip = await versionZip(app, number);
  if (!zip) return notFound();

  const iterator = zip.stream;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(new Uint8Array(next.value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zip.filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
