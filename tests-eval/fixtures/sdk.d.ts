// drobek SDK types — `import { drobek } from 'drobek'`. Generated at server start;
// only the platform modules active on this server are listed.
/** A failed module call. `code` is the stable error code, `hint` what to do. */
export declare class DrobekError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly hint?: string;
}

export declare namespace auth {
  export interface User {
    id: string;
    email: string;
    role: 'user' | 'admin';
  }
  export interface Api {
    /** The signed-in user of THIS host, or null. Also extends the 30-day session. */
    me(): Promise<User | null>;
    /** E-mail a 6-digit code (valid 10 minutes). Rejects: email_not_allowed (403), rate_limited (429). */
    sendCode(email: string): Promise<{ sent: true; email: string; expires_in: number }>;
    /** Code → session cookie. Rejects: invalid_code (400), too_many_attempts (429), email_not_allowed (403). */
    verify(email: string, code: string): Promise<User>;
    logout(): Promise<void>;
    /** Called when me/verify/logout change the user; returns the unsubscribe function. */
    onChange(listener: (user: User | null) => void): () => void;
  }
}

export declare namespace email {
  export interface Api {
    /**
     * E-mail the app's owners (the editors and admins of its drobek workspace).
     * Needs a signed-in user (auth module). subject ≤ 150, text ≤ 5000 characters.
     * Rejects: unauthorized (401), limit_exceeded (429), unavailable (503).
     */
    notifyAdmins(subject: string, text: string): Promise<{ sent: number }>;
  }
}

export declare namespace forms {
  export type FieldValue = string | number | boolean | null | string[];
  export interface Submission {
    id: string;
    created_at: string;
    data: Record<string, FieldValue>;
    user_id: string | null;
    notified: boolean;
  }
  export interface Api {
    /** Fetch the form's time token early (e.g. when the form mounts); submit() then never waits. */
    prepare(form: string): Promise<void>;
    /**
     * Store a submission (and e-mail the owners). Waits until the token is ≥ 2 s old.
     * FormData or a flat object; no files. Rejects: invalid_request (400), unauthorized (401),
     * rate_limited / limit_exceeded (429).
     */
    submit(form: string, data: Record<string, FieldValue> | FormData): Promise<{ ok: true; id: string }>;
    /** Newest first, ≤ 100 per page (admins only). */
    submissions(form: string, opts?: { limit?: number; before?: string }): Promise<{ submissions: Submission[]; next_cursor: string | null }>;
    /** The CSV export URL (admins only), e.g. for <a href download>. */
    csvUrl(form: string): string;
  }
}

export declare namespace data {
  export type Scalar = string | number | boolean | null;
  /** A stored record: the server's fields (_…) plus yours. */
  export type Doc<T> = T & { _id: string; _owner: string | null; _created_at: string; _updated_at: string };
  /** A value (equality) or operators: eq ne gt gte lt lte in contains. */
  export type Condition =
    | Scalar
    | { eq?: Scalar; ne?: Scalar; gt?: number | string; gte?: number | string; lt?: number | string; lte?: number | string; in?: Scalar[]; contains?: Scalar };
  export type Filter<T> = { [K in keyof T]?: Condition };
  export interface ListOptions<T> {
    filter?: Filter<T>;
    /** Default: _created_at, newest first. */
    sort?: (keyof T & string) | '_id' | '_created_at' | '_updated_at';
    dir?: 'asc' | 'desc';
    /** 1–200, default 50. */
    limit?: number;
    /** next_cursor of the previous page. */
    cursor?: string | null;
  }
  export interface Page<T> { records: Doc<T>[]; next_cursor: string | null }
  export interface Collection<T> {
    /** Under a read rule with owner (e.g. "owner|admin") a user gets only their own records. */
    list(opts?: ListOptions<T>): Promise<Page<T>>;
    get(id: string): Promise<Doc<T>>;
    /** _owner = the signed-in user (null for a visitor). Keys starting with _ are dropped. */
    create(fields: T): Promise<Doc<T>>;
    /** Shallow merge of the given fields. */
    update(id: string, fields: Partial<T>): Promise<Doc<T>>;
    remove(id: string): Promise<{ id: string; deleted: true }>;
    /** The CSV export URL (admins only), e.g. for <a href download>. */
    exportCsvUrl(opts?: Pick<ListOptions<T>, 'filter' | 'sort' | 'dir'>): string;
  }
  export interface Api {
    /** A collection the app's config declares. */
    collection<T extends object = Record<string, unknown>>(name: string): Collection<T>;
  }
}

export declare namespace proxy {
  export interface Api {
    /**
     * fetch() an assigned upstream through drobek: `path` (and its ?query) is
     * appended to the upstream's base URL. The server injects the upstream's
     * secret; never put a key in the app. Resolves with the standard Response
     * (any status — check res.ok): drobek refusals are JSON { error, message }
     * with 401/403 (rules), 404 (not registered), 405/403 (method/path not
     * allowed), 429 (rate limited), 502 (upstream unreachable).
     */
    fetch(upstream: string, path?: string, init?: RequestInit): Promise<Response>;
  }
}

export declare namespace files {
  /** A stored file. */
  export interface StoredFile {
    id: string;
    /** Same-origin URL of the bytes — use it as <img src>, <a href>, <iframe src> (PDF). */
    url: string;
    size: number;
    /** The type drobek detected from the bytes: image/png|jpeg|gif|webp|svg+xml, application/pdf, text/csv. */
    type: string;
    /** The uploaded file's name (the download name). */
    name: string;
    /** The uploader's end-user id (null: an anonymous upload). */
    owner: string | null;
    created_at: string;
  }
  export interface FilesPage { files: StoredFile[]; next_cursor: string | null; used_bytes: number; quota_bytes: number }
  export interface Api {
    /** Upload one file (e.g. from <input type="file">). The signed-in uploader becomes its owner. */
    upload(file: Blob, opts?: { name?: string; signal?: AbortSignal }): Promise<StoredFile>;
    /** The URL of a stored file (store the id, e.g. in a data record; build the URL when rendering). */
    url(id: string): string;
    /** Delete a file (its uploader or an app admin). */
    remove(id: string): Promise<{ id: string; deleted: true }>;
    /** Every file of the app, newest first (app admins only). */
    list(opts?: { limit?: number; cursor?: string | null }): Promise<FilesPage>;
  }
}

export interface Drobek {
  /** Use when people must sign in to the app (only some e-mails or a company domain, admins, per-user data) — skill_info('auth') */
  readonly auth: auth.Api;
  /** Use when the app must tell its owners about something by e-mail (a request, an alert), or you want to set the sender name of the app's e-mails — skill_info('email') */
  readonly email: email.Api;
  /** Use when visitors fill in a form (contact, order, sign-up, feedback) and the answers must be kept or e-mailed to the owner — skill_info('forms') */
  readonly forms: forms.Api;
  /** Use when the app stores records (lists, todos, entries, votes, a shared or per-user database) — instead of Firebase, Supabase or localStorage — skill_info('data') */
  readonly data: data.Api;
  /** Use when the app calls an external API that needs a secret key (OpenAI, Anthropic, Stripe, any REST backend) — instead of putting the key in the browser — skill_info('proxy') */
  readonly proxy: proxy.Api;
  /** Use when the user uploads files (photos, avatars, PDFs, CSVs) the app stores and shows or downloads later — instead of Firebase Storage, S3, Cloudinary or UploadThing — skill_info('files') */
  readonly files: files.Api;
}
export declare const drobek: Drobek;
export default drobek;

// ── import { … } from 'drobek/auth' — compiled into the app with its own import map ──
// import type { JSX, ReactNode } from 'react';
// export interface User { id: string; email: string; role: 'user' | 'admin' }
// export interface LoginGateProps {
//   /** What signed-in users see; a function gets the user. */
//   children: ReactNode | ((user: User) => ReactNode);
//   /** Heading of the sign-in form (default "Sign in"). */
//   title?: string;
//   /** Only admins get through; other signed-in users see "no access" and a sign-out button. */
//   requireAdmin?: boolean;
//   /** Shown while the session is checked (default: nothing). */
//   loading?: ReactNode;
// }
// export function LoginGate(props: LoginGateProps): JSX.Element;
// export function useAuth(): { user: User | null; loading: boolean; error: string | null; logout(): Promise<void>; refresh(): Promise<void> };

// ── import { … } from 'drobek/forms' — compiled into the app with its own import map ──
// import type { FormHTMLAttributes, JSX, ReactNode } from 'react';
// export interface FormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'onError' | 'name' | 'action' | 'method' | 'children'> {
//   /** The form's name: lowercase letters, digits, - and _ (max 40). */
//   name: string;
//   /** Your inputs (each with a name) and a submit button. */
//   children: ReactNode;
//   /** Shown instead of the fields after a successful submit (default "Thank you — sent."). */
//   success?: ReactNode;
//   onSuccess?: (result: { id: string }) => void;
//   onError?: (error: { code: string; message: string }) => void;
// }
// export function Form(props: FormProps): JSX.Element;
