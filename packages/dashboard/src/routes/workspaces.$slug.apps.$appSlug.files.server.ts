/**
 * GET /workspaces/:slug/apps/:appSlug/files — server half of the Files tab
 * (NSO-288). viewer+, read-only: the chosen version's file tree (source and
 * built outputs), one file's content for the viewer and the ZIP download
 * link. `?version=N` (default: the newest), `?path=…&kind=source|built`
 * (default: index.html / the first source file). The UI is not a builder —
 * there is no editing here; agents write files over MCP.
 */
import { data, type LoaderFunctionArgs } from 'react-router';
import { getVersion, listVersions, readVersionFile } from '@drobek/apps';
import { appHeaderData, loadAppPage } from '../app-page.server.js';
import { buildFileTree, defaultFile } from '../app-view.js';
import { languageOf } from '../highlight.js';

/** The viewer shows at most this much of a file (compiled bundles can be large). */
export const VIEWER_MAX_BYTES = 256 * 1024;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const lenient = new TextDecoder('utf-8');

function asText(bytes: Buffer): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

function positiveInt(raw: string | null): number | null {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const page = await loadAppPage(request, params, 'viewer');
  const { app } = page;
  const url = new URL(request.url);

  const [header, all] = await Promise.all([appHeaderData(page), listVersions(app.id, { limit: 500 })]);
  const number = positiveInt(url.searchParams.get('version')) ?? all[0]?.number ?? null;
  const version = number !== null ? await getVersion(app.id, { number }) : null;
  if (number !== null && !version) throw data({ message: 'Not found' }, { status: 404 });

  const files = version?.files ?? [];
  const kindParam = url.searchParams.get('kind');
  const pathParam = url.searchParams.get('path');
  const picked =
    pathParam !== null
      ? { path: pathParam, kind: kindParam === 'built' ? ('built' as const) : ('source' as const) }
      : defaultFile(files);
  const entry = picked ? files.find((f) => f.path === picked.path && f.kind === picked.kind) : undefined;

  let file: {
    path: string;
    kind: 'source' | 'built';
    size: number;
    text: string | null;
    truncated: boolean;
    language: ReturnType<typeof languageOf>;
  } | null = null;
  if (version && entry) {
    const bytes = await readVersionFile(version.id, entry.path, entry.kind);
    const truncated = !!bytes && bytes.length > VIEWER_MAX_BYTES;
    const shown = bytes ? bytes.subarray(0, VIEWER_MAX_BYTES) : null;
    // A cut inside a UTF-8 sequence is fine for display: decode a truncated view leniently.
    const text = !shown || shown.includes(0) ? null : truncated ? lenient.decode(shown) : asText(shown);
    file = {
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      text,
      truncated,
      language: languageOf(entry.path),
    };
  }

  return {
    header,
    versions: all.map((v) => ({ number: v.number, compileStatus: v.compileStatus, published: v.published })),
    version: version
      ? {
          number: version.number,
          compileStatus: version.compileStatus,
          published: version.published,
          createdAt: version.createdAt.toISOString(),
          fileCount: files.length,
        }
      : null,
    tree: { source: buildFileTree(files, 'source'), built: buildFileTree(files, 'built') },
    selected: picked,
    file,
    downloadUrl: version ? `${header.basePath}/files/download?version=${version.number}` : null,
  };
}
