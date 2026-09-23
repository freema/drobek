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
import { SourceFooter } from '@drobek/dashboard/footer';

/**
 * M2-04 (NSO-284): the build sha for the AGPL-3.0 §13 source link in the
 * footer (the same GIT_SHA `/api/version` reports). Constant per process, so
 * the root never revalidates for it.
 */
export function loader() {
  return { sourceSha: process.env.GIT_SHA || 'dev' };
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
        {/* data: favicon — no external assets, no favicon 404 console noise */}
        <link rel="icon" href="data:," />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <SourceFooter sha={root?.sourceSha} />
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
      <h1>drobek</h1>
      <p>{message}</p>
    </main>
  );
}
