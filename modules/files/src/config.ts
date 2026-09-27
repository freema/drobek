/**
 * The files module's per-app config (§5.0, §5.5):
 *
 *   { rules: { upload, read }, maxBytes?, allowedTypes }
 *
 *  - `rules.upload` — who may upload (default `user`: any signed-in user);
 *    `owner` means the same as `user` here (the uploader becomes the owner).
 *  - `rules.read`   — who may download a file (default `user`); `owner` = the
 *    uploader. `public` makes every file reachable by anyone with its URL.
 *  - Deleting a file is always `owner|admin` (the uploader or an app admin).
 *  - `maxBytes` — this app's per-file cap; it can only LOWER the operator's
 *    FILES_MAX_BYTES (the smaller one wins).
 *  - `allowedTypes` — a subset of TYPE_PATTERNS in sniff.ts, including
 *    image/* and the supported image, PDF and CSV MIME types. The type is
 *    sniffed from the bytes, not inferred from the filename.
 *
 * Changes that need the owner's confirmation (confirmRequired):
 *  - `upload` opened to `public` (anyone can fill the app's storage);
 *  - `read` opened to `public` while the app holds files (they all become
 *    downloadable by anyone with a link) — on an app without files it applies.
 */
import { isValidRule, ruleIsPublic, z, type ConfirmContext } from '@drobek/modules';
import { TYPE_PATTERNS } from './sniff.js';
import { countFiles } from './store.js';

export const DEFAULT_ALLOWED_TYPES = ['image/*', 'application/pdf', 'text/csv'] as const;
/** The largest per-app `maxBytes` a config can name (the operator's FILES_MAX_BYTES caps it anyway). */
export const MAX_CONFIG_BYTES = 1024 * 1024 * 1024;

const rule = z
  .string()
  .trim()
  .max(60)
  .refine(isValidRule, 'a rule is public, user, owner, admin or none — alternatives joined with | (e.g. "user|admin")');

export const DEFAULT_FILE_RULES = Object.freeze({ upload: 'user', read: 'user' });

export const filesConfigSchema = z.strictObject({
  /** Who may upload / download (each a rule). Delete is always owner|admin. */
  rules: z
    .strictObject({
      upload: rule.default(DEFAULT_FILE_RULES.upload).meta({
        title: 'Who may upload',
        description: 'A rule: public, user, owner, admin or none, alternatives joined with |. Opening it to public waits for the owner’s confirmation.',
      }),
      read: rule.default(DEFAULT_FILE_RULES.read).meta({
        title: 'Who may download',
        description: 'A rule like the one above; owner means the uploader. Opening it to public while the app holds files waits for the owner’s confirmation.',
      }),
    })
    .default({ ...DEFAULT_FILE_RULES })
    .meta({ title: 'Access', description: 'Deleting a file is always allowed to its uploader and the app’s admins.' }),
  /** Per-file cap in bytes for this app (≤ the operator's FILES_MAX_BYTES, which wins). */
  maxBytes: z.number().int().min(1).max(MAX_CONFIG_BYTES).optional().meta({
    title: 'Largest file (bytes)',
    description: 'This app’s cap per file, e.g. 5242880 for 5 MB. It can only lower the server’s limit. Empty: the server’s limit.',
  }),
  /** The accepted types (sniffed from the bytes). */
  allowedTypes: z
    .array(z.enum(TYPE_PATTERNS))
    .min(1)
    .max(TYPE_PATTERNS.length)
    .default([...DEFAULT_ALLOWED_TYPES])
    .meta({ title: 'Accepted file types', description: 'Checked against the file’s bytes, not its name.' }),
});

export type FilesConfig = z.infer<typeof filesConfigSchema>;

export const FILES_CONFIG_DEFAULTS: FilesConfig = {
  rules: { ...DEFAULT_FILE_RULES },
  allowedTypes: [...DEFAULT_ALLOWED_TYPES],
};

/** The rule that deletes a file (fixed). */
export const DELETE_RULE = 'owner|admin';

/** The changes between two valid configs that wait for the owner (see the file header). */
export async function filesConfirmRequired(before: FilesConfig, after: FilesConfig, context: ConfirmContext): Promise<string[]> {
  const out: string[] = [];
  if (ruleIsPublic(after.rules.upload) && !ruleIsPublic(before.rules.upload)) {
    out.push(`files.rules.upload: "${before.rules.upload}" → "${after.rules.upload}" (anyone, signed in or not, may upload files into the app's storage)`);
  }
  if (ruleIsPublic(after.rules.read) && !ruleIsPublic(before.rules.read)) {
    const n = await countFiles(context.db, context.app.id);
    if (n > 0) {
      out.push(
        `files.rules.read: "${before.rules.read}" → "${after.rules.read}" (anyone with a link may download all ${n} stored file${n === 1 ? '' : 's'} and every future one)`
      );
    }
  }
  return out;
}
