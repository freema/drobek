/**
 * /workspaces/:slug/apps/:appSlug/files — the Files tab (NSO-288): pick a
 * version, browse its tree (source + built outputs), read one file in a
 * read-only viewer with a light syntax highlight, download the version as a
 * ZIP. No editing (the UI is not a builder) and no in-dashboard preview (the
 * dashboard origin never runs app code — "Open" links go to the apps origin).
 * App source is rendered as React text inside <span>s (highlight.ts only
 * tokenizes), so nothing in a file can become markup here.
 */
import { Form, Link, useLoaderData } from 'react-router';
import type { loader } from './workspaces.$slug.apps.$appSlug.files.server.js';
import { AppHeader, appStyles } from '../app-header.js';
import { formatBytes, type TreeNode } from '../app-view.js';
import { highlight, type TokenKind } from '../highlight.js';
import { formatTimestamp } from '../view.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Files — ${data?.header.name ?? data?.header.slug ?? 'App'} — drobek` }];
}

const s = appStyles;

const TOKEN_COLOR: Record<TokenKind, string> = {
  comment: '#6b7280',
  string: '#047857',
  number: '#b45309',
  keyword: '#7c3aed',
  tag: '#1d4ed8',
  attr: '#b45309',
  punct: '#52525b',
};

const styles = {
  layout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(12rem, 16rem) 1fr',
    gap: '1.25rem',
    marginTop: '1.25rem',
    alignItems: 'start',
  },
  tree: { listStyle: 'none', margin: 0, paddingLeft: '0.9rem', fontSize: '0.86rem' },
  treeRoot: { listStyle: 'none', margin: 0, padding: 0, fontSize: '0.86rem' },
  folder: { color: '#52525b', fontWeight: 600 },
  fileLink: { color: '#1a1a1a', textDecoration: 'none', fontFamily: 'ui-monospace, monospace', fontSize: '0.82rem' },
  fileActive: {
    color: '#1a1a1a',
    textDecoration: 'none',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.82rem',
    background: '#e4e4e7',
    borderRadius: '4px',
    padding: '0 0.25rem',
  },
  groupTitle: {
    fontSize: '0.72rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#71717a',
    margin: '0 0 0.25rem',
  },
  viewerHead: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.5rem',
    flexWrap: 'wrap',
    fontSize: '0.85rem',
    color: '#52525b',
    marginBottom: '0.4rem',
  },
  pre: {
    margin: 0,
    padding: '0.8rem 0.9rem',
    background: '#fafafa',
    border: '1px solid #e4e4e7',
    borderRadius: '8px',
    overflow: 'auto',
    maxHeight: '70vh',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.8rem',
    lineHeight: 1.5,
    whiteSpace: 'pre',
    tabSize: 2,
  },
  toolbar: { display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '1.25rem' },
  select: { padding: '0.3rem 0.4rem', fontSize: '0.88rem', fontFamily: 'inherit' },
} as const;

function Tree({
  nodes,
  kind,
  hrefFor,
  selected,
  root = false,
}: {
  nodes: TreeNode[];
  kind: 'source' | 'built';
  hrefFor: (path: string, kind: 'source' | 'built') => string;
  selected: { path: string; kind: string } | null;
  root?: boolean;
}) {
  return (
    <ul style={root ? styles.treeRoot : styles.tree}>
      {nodes.map((n) =>
        n.children ? (
          <li key={`d:${n.path}`}>
            <span style={styles.folder}>{n.name}/</span>
            <Tree nodes={n.children} kind={kind} hrefFor={hrefFor} selected={selected} />
          </li>
        ) : (
          <li key={`f:${n.path}`}>
            <Link
              to={hrefFor(n.path, kind)}
              style={selected?.path === n.path && selected.kind === kind ? styles.fileActive : styles.fileLink}
              data-testid="file-link"
              data-path={n.path}
              data-kind={kind}
            >
              {n.name}
            </Link>
          </li>
        )
      )}
    </ul>
  );
}

export default function AppFilesRoute() {
  const { header, versions, version, tree, selected, file, downloadUrl } = useLoaderData<typeof loader>();
  const filesBase = `${header.basePath}/files`;
  const hrefFor = (path: string, kind: 'source' | 'built') =>
    `${filesBase}?version=${version?.number ?? ''}&kind=${kind}&path=${encodeURIComponent(path)}`;
  const tokens = file && file.text !== null ? highlight(file.text, file.language) : [];

  return (
    <main style={s.main}>
      <AppHeader header={header} />

      {version === null ? (
        <p style={{ ...s.muted, marginTop: '1.25rem' }} data-testid="files-empty">
          No versions yet — your agent writes the first one.
        </p>
      ) : (
        <>
          <div style={styles.toolbar}>
            <Form method="get" action={filesBase} style={s.inline}>
              <label htmlFor="files-version" style={s.label}>
                Version
              </label>
              <select
                id="files-version"
                name="version"
                defaultValue={String(version.number)}
                style={styles.select}
                data-testid="files-version-select"
              >
                {versions.map((v) => (
                  <option key={v.number} value={v.number}>
                    v{v.number}
                    {v.published ? ' · published' : ''}
                    {v.compileStatus === 'error' ? ' · compile errors' : ''}
                  </option>
                ))}
              </select>
              <button type="submit" style={s.secondaryButton} data-testid="files-version-apply">
                Show
              </button>
            </Form>
            <span style={s.muted}>
              v{version.number} · {version.fileCount} files · {formatTimestamp(version.createdAt)}
            </span>
            {downloadUrl ? (
              <a href={downloadUrl} download data-testid="files-download-link" style={{ fontWeight: 600 }}>
                Download v{version.number} (.zip)
              </a>
            ) : null}
          </div>

          <div style={styles.layout}>
            <nav aria-label="Files" data-testid="file-tree">
              <p style={styles.groupTitle}>Source</p>
              {tree.source.length === 0 ? (
                <p style={s.muted}>none</p>
              ) : (
                <Tree nodes={tree.source} kind="source" hrefFor={hrefFor} selected={selected} root />
              )}
              <p style={{ ...styles.groupTitle, marginTop: '0.9rem' }}>Built</p>
              {tree.built.length === 0 ? (
                <p style={s.muted}>none</p>
              ) : (
                <Tree nodes={tree.built} kind="built" hrefFor={hrefFor} selected={selected} root />
              )}
            </nav>

            <section data-testid="file-viewer" aria-label="File content">
              {file === null ? (
                <p style={s.muted}>{selected ? `No file "${selected.path}" in v${version.number}.` : 'Pick a file.'}</p>
              ) : (
                <>
                  <div style={styles.viewerHead}>
                    <code style={s.mono} data-testid="file-viewer-path">
                      {file.kind}/{file.path}
                    </code>
                    <span>
                      {formatBytes(file.size)}
                      {file.truncated ? ' · showing the first 256 KiB' : ''}
                    </span>
                  </div>
                  {file.text === null ? (
                    <p style={s.muted} data-testid="file-binary">
                      Binary file — download the version to get it.
                    </p>
                  ) : (
                    <pre style={styles.pre} data-testid="file-content">
                      <code>
                        {tokens.map((t, i) =>
                          t.kind ? (
                            <span key={i} style={{ color: TOKEN_COLOR[t.kind] }}>
                              {t.text}
                            </span>
                          ) : (
                            <span key={i}>{t.text}</span>
                          )
                        )}
                      </code>
                    </pre>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  );
}
