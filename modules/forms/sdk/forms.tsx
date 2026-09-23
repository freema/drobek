/**
 * `import { Form } from 'drobek/forms'` — the forms module's React part
 * (M1-04). NOT in /__drobek/sdk.js: the drobek compiler builds this file INTO
 * the app that imports it, resolving `react` through the app's own
 * drobek.json (the app and the form share one React) and `drobek` to the
 * server's SDK (the same `drobek.forms` instance the app sees).
 *
 * <Form name="contact"> renders a normal <form> around your fields, adds the
 * invisible honeypot field, fetches the time token when it mounts, and on
 * submit sends every named field through drobek.forms.submit(). After a
 * success it shows `success` instead of the fields.
 *
 * Self-contained on purpose: it may import only `react` and `drobek`.
 */
import { useEffect, useState, type CSSProperties, type FormEvent, type FormHTMLAttributes, type ReactNode } from 'react';
import { drobek } from 'drobek';

export interface FormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'onError' | 'name' | 'action' | 'method' | 'children'> {
  /** The form's name on the server (`/__drobek/v1/forms/<name>`): lowercase letters, digits, - and _. */
  name: string;
  /** Your inputs (each with a `name`) and a submit button. */
  children: ReactNode;
  /** Shown instead of the fields after a successful submit (default "Thank you — sent."). */
  success?: ReactNode;
  onSuccess?: (result: { id: string }) => void;
  onError?: (error: { code: string; message: string }) => void;
}

type Status = { state: 'idle' } | { state: 'sending' } | { state: 'sent' } | { state: 'error'; message: string };

function errorInfo(err: unknown): { code: string; message: string } {
  const o = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; message?: unknown };
  return { code: typeof o.code === 'string' ? o.code : '', message: typeof o.message === 'string' ? o.message : String(err) };
}

function messageFor(code: string): string {
  switch (code) {
    case 'rate_limited':
      return 'Too many submissions from here. Try again later.';
    case 'limit_exceeded':
      return 'This form cannot take more submissions today. Try again tomorrow.';
    case 'unauthorized':
      return 'Sign in first to send this form.';
    case 'invalid_request':
      return 'Check the fields and try again.';
    case 'payload_too_large':
      return 'The form is too long. Shorten the text and try again.';
    default:
      return 'The form could not be sent. Try again in a moment.';
  }
}

const hidden: CSSProperties = { position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden' };
const fieldset: CSSProperties = { border: 0, padding: 0, margin: 0, minWidth: 0, display: 'contents' };

/** A form whose submissions drobek stores and e-mails to the app's owners. */
export function Form({ name, children, success, onSuccess, onError, ...rest }: FormProps) {
  const [status, setStatus] = useState<Status>({ state: 'idle' });

  useEffect(() => {
    // Fetch the time token early: by the time a person submits, it is old enough.
    drobek.forms.prepare(name).catch(() => {});
  }, [name]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.state === 'sending') return;
    setStatus({ state: 'sending' });
    try {
      const result = await drobek.forms.submit(name, new FormData(e.currentTarget));
      setStatus({ state: 'sent' });
      onSuccess?.({ id: result.id });
    } catch (err) {
      const info = errorInfo(err);
      setStatus({ state: 'error', message: messageFor(info.code) });
      onError?.(info);
    }
  }

  if (status.state === 'sent') {
    return (
      <div role="status" className="drobek-form-success">
        {success ?? <p>Thank you — sent.</p>}
      </div>
    );
  }

  return (
    <form {...rest} name={name} data-drobek-form={name} onSubmit={submit} aria-busy={status.state === 'sending'}>
      <div aria-hidden="true" style={hidden}>
        <label>
          Leave this field empty
          <input type="text" name="_hp" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>
      <fieldset disabled={status.state === 'sending'} style={fieldset}>
        {children}
      </fieldset>
      {status.state === 'error' && (
        <p role="alert" className="drobek-form-error" style={{ color: '#c0362c' }}>
          {status.message}
        </p>
      )}
    </form>
  );
}
