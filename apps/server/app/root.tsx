import type { ReactNode } from 'react';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
  useRouteLoaderData,
} from 'react-router';
import { mascotDataUri } from '@drobek/auth';
import { DrobekMark } from '@drobek/auth/mark';
import { SourceFooter } from '@drobek/dashboard/footer';

const FAVICON = mascotDataUri();
import { githubStars } from '@drobek/dashboard/github-stars.server';

/**
 * M2-04 (NSO-284): the build sha for the AGPL-3.0 §13 source link in the
 * footer (the same GIT_SHA `/api/version` reports); NSO-342: plus the release
 * version (DROBEK_VERSION) and the repository's GitHub stars — answered from
 * memory, never awaited (null while unknown or when DASHBOARD_GITHUB_STARS is
 * off). The root never revalidates for them: they change once per document.
 */
export function loader() {
  return {
    sourceSha: process.env.GIT_SHA || 'dev',
    version: process.env.DROBEK_VERSION || 'dev',
    stars: githubStars(),
  };
}

export function shouldRevalidate() {
  return false;
}

export function Layout({ children }: { children: ReactNode }) {
  const root = useRouteLoaderData<typeof loader>('root');
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* D1: noindex during beta */}
        <meta name="robots" content="noindex" />
        {/* data: favicon (the mascot) — no external assets, no favicon 404 console noise */}
        <link rel="icon" href={FAVICON} type="image/svg+xml" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <SourceFooter sha={root?.sourceSha} version={root?.version} stars={root?.stars} />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : 'Unexpected error';
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem' }}>
      <DrobekMark size={48} />
      <h1>drobek</h1>
      <p>{message}</p>
    </main>
  );
}
