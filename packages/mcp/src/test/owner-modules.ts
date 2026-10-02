/**
 * The owner-facing module authorities the owner tool tests drive, kept in
 * memory per app id:
 *   - `inbox`   — `submissions` (form submissions, newest first, offset cursors);
 *   - `members` — `endUsers` (list / setRole / setDisabled); the admin role
 *                 follows the config's `admins` (a config change), an address
 *                 starting with `editor@` is always admin (conflict);
 *   - `drive`   — `files` (uploads).
 */
import { Readable } from 'node:stream';
import { ModuleError, defineModule, z, type EndUserRecord, type OwnerFile, type OwnerSubmission } from '@drobek/modules';

/** app id → its submissions, newest first. */
export const INBOX = new Map<string, OwnerSubmission[]>();

function offsetPage<T>(all: T[], limit: number | undefined, cursor: string | null | undefined): { items: T[]; next_cursor: string | null } {
  if (cursor && !/^\d+$/.test(cursor)) throw new ModuleError('invalid_request', 'The cursor is not valid — use next_cursor of the previous page.');
  const start = cursor ? Number(cursor) : 0;
  const n = limit ?? 25;
  return { items: all.slice(start, start + n), next_cursor: start + n < all.length ? String(start + n) : null };
}

export const inbox = defineModule<{ forms: string[] }>({
  name: 'inbox',
  version: '1.0.0',
  skill: { useWhen: 'the app collects form submissions', markdown: '# inbox\n' },
  configSchema: z.object({ forms: z.array(z.string()) }),
  configDefaults: { forms: ['contact'] },
  submissions: {
    async forms(view) {
      const all = INBOX.get(view.app.id) ?? [];
      const names = new Set([...view.config.forms, ...all.map((s) => s.form)]);
      return [...names].sort().map((name) => ({ name, submissions: all.filter((s) => s.form === name).length }));
    },
    async list(view, q) {
      const all = (INBOX.get(view.app.id) ?? []).filter(
        (s) => (!q.form || s.form === q.form) && (!q.from || s.created_at >= q.from) && (!q.to || s.created_at < q.to)
      );
      const page = offsetPage(all, q.limit, q.cursor);
      return { submissions: page.items, total: all.length, next_cursor: page.next_cursor };
    },
    async *csv() {},
    async remove(view, id) {
      const all = INBOX.get(view.app.id) ?? [];
      const i = all.findIndex((s) => s.id === id);
      if (i < 0) return false;
      all.splice(i, 1);
      return true;
    },
  },
});

interface MemberRow {
  id: string;
  email: string;
  disabled: boolean;
}

/** app id → its end users, newest first. */
export const MEMBERS = new Map<string, MemberRow[]>();

function memberRecord(row: MemberRow, admins: string[]): EndUserRecord {
  const editor = row.email.startsWith('editor@');
  const role = editor || admins.includes(row.email) ? 'admin' : 'user';
  return {
    id: row.id,
    email: row.email,
    role,
    roleSource: role === 'admin' ? (editor ? 'workspace' : 'config') : null,
    status: row.disabled ? 'disabled' : 'active',
    provider: 'email',
    created_at: '2026-09-20T10:00:00.000Z',
    last_sign_in_at: null,
  };
}

export const members = defineModule<{ admins: string[] }>({
  name: 'members',
  version: '1.0.0',
  skill: { useWhen: 'the app signs its users in', markdown: '# members\n' },
  configSchema: z.object({ admins: z.array(z.string()) }),
  configDefaults: { admins: [] },
  secrets: [{ name: 'MEMBERS_SSO_SECRET', description: 'the sign-in provider secret', required: false }],
  endUsers: {
    async current({ user }) {
      return user;
    },
    async list(view, q) {
      const all = (MEMBERS.get(view.app.id) ?? []).filter((u) => !q.search || u.email.includes(q.search));
      const page = offsetPage(all, q.limit, q.cursor);
      return { users: page.items.map((u) => memberRecord(u, view.config.admins)), total: all.length, next_cursor: page.next_cursor };
    },
    async setRole(view, id, role) {
      const row = (MEMBERS.get(view.app.id) ?? []).find((u) => u.id === id);
      if (!row) throw new ModuleError('not_found', 'No such user of this app.');
      if (row.email.startsWith('editor@') && role === 'user') {
        throw new ModuleError('conflict', `${row.email} is an editor of this app's workspace and always an admin.`, { details: { reason: 'workspace_editor' } });
      }
      const admins = role === 'admin' ? [...new Set([...view.config.admins, row.email])] : view.config.admins.filter((e) => e !== row.email);
      return { user: memberRecord(row, admins), configPatch: { admins } };
    },
    async setDisabled(view, id, disabled) {
      const row = (MEMBERS.get(view.app.id) ?? []).find((u) => u.id === id);
      if (!row) return null;
      row.disabled = disabled;
      return memberRecord(row, view.config.admins);
    },
  },
});

/** app id → its uploads, newest first. */
export const DRIVE = new Map<string, OwnerFile[]>();

export const drive = defineModule<Record<string, never>>({
  name: 'drive',
  version: '1.0.0',
  skill: { useWhen: 'the app takes file uploads', markdown: '# drive\n' },
  configSchema: z.object({}),
  configDefaults: {},
  files: {
    async list(view, q) {
      const all = DRIVE.get(view.app.id) ?? [];
      const page = offsetPage(all, q.limit, q.cursor);
      return { files: page.items, next_cursor: page.next_cursor, used_bytes: all.reduce((n, f) => n + f.size, 0), quota_bytes: 1_000_000 };
    },
    async open(view, id) {
      const file = (DRIVE.get(view.app.id) ?? []).find((f) => f.id === id);
      return file ? { file, stream: Readable.from([Buffer.from('bytes')]) } : null;
    },
    async remove(view, id) {
      const all = DRIVE.get(view.app.id) ?? [];
      const i = all.findIndex((f) => f.id === id);
      if (i < 0) return false;
      all.splice(i, 1);
      return true;
    },
  },
});
