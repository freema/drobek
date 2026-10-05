import type { ReactNode } from 'react';
import {
  isRouteErrorResponse,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
  useRouteLoaderData,
} from 'react-router';
import { DrobekMark, mascotDataUri } from '@drobek/auth/mark';
import { SourceFooter } from '@drobek/dashboard/footer';
import { githubStars } from '@drobek/dashboard/github-stars.server';
import { WhatsNewBanner } from '@drobek/dashboard/whats-new-banner';
import { loadWhatsNewBanner } from '@drobek/dashboard/whats-new.server';

const FAVICON = mascotDataUri();

/**
 * The build sha for the AGPL-3.0 §13 source link in the
 * footer (the same GIT_SHA `/api/version` reports), the release
 * version (DROBEK_VERSION) and the repository's GitHub stars — answered from
 * memory, never awaited (null while unknown or when DASHBOARD_GITHUB_STARS is
 * off) — plus the "What's new" notice for a signed-in person. The root
 * revalidates only after a form submission (sign-in, sign-out), which can
 * change whether the notice applies; the other values change once per document.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return {
    sourceSha: process.env.GIT_SHA || 'dev',
    version: process.env.DROBEK_VERSION || 'dev',
    stars: githubStars(),
    whatsNew: await loadWhatsNewBanner(request),
  };
}

export function shouldRevalidate({ formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return formMethod !== undefined && formMethod.toUpperCase() !== 'GET' && defaultShouldRevalidate;
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
        {root?.whatsNew ? <WhatsNewBanner line={root.whatsNew.line} /> : null}
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
