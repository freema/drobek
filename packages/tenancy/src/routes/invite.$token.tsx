/**
 * /invite/:token — client half: sign-in prompt for anonymous
 * visitors, accept button for signed-in ones, and the generic invalid-invite
 * ErrorBoundary (404) for expired/used/garbage tokens.
 */
import {
  Form,
  isRouteErrorResponse,
  Link,
  useLoaderData,
  useNavigation,
  useRouteError,
} from 'react-router';
import { PlatformPage } from '@drobek/auth/platform-page';
import type { loader } from './invite.$token.server.js';

export function meta() {
  return [{ title: 'Workspace invite — drobek' }];
}

export default function InviteAcceptRoute() {
  const { anonymous, workspaceName, role } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';

  return (
    <PlatformPage page="invite">
      <h1>You&apos;re invited</h1>
      <p className="drobek-hint">
        You have been invited to join <strong>{workspaceName}</strong> as{' '}
        <strong>{role}</strong>.
      </p>

      {anonymous ? (
        <>
          <p className="drobek-hint">
            Sign in first, then open this invite link again to accept it.
          </p>
          <a href="/login" className="drobek-button drobek-button-block">
            Sign in to accept
          </a>
        </>
      ) : (
        <Form method="post">
          <button type="submit" disabled={submitting} className="drobek-button drobek-button-block">
            {submitting ? 'Accepting…' : 'Accept invite'}
          </button>
        </Form>
      )}
    </PlatformPage>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const invalid = isRouteErrorResponse(error) && error.status === 404;

  return (
    <PlatformPage page="invite-invalid">
      <h1>Workspace invite</h1>
      <p className="drobek-hint">
        {invalid
          ? 'This invite is not valid or has expired. Ask the person who invited you for a new link.'
          : 'Something went wrong while opening this invite. Try the link again in a moment.'}
      </p>
      <p className="drobek-foot">
        <Link to="/">← Home</Link>
      </p>
    </PlatformPage>
  );
}
