import type { AuditActorKind } from '@drobek/audit';

/** Who is acting — resolved server-side (MCP tool → agent, dashboard → user). */
export interface Actor {
  userId: string | null;
  kind: AuditActorKind;
}

export type CompileStatus = 'pending' | 'ok' | 'error';
export type VersionFileKind = 'source' | 'built';

export interface VersionFileInput {
  path: string;
  content: string | Buffer;
  /** Defaults to `source`. */
  kind?: VersionFileKind;
}

export interface VersionFile {
  path: string;
  sha256: string;
  size: number;
  kind: VersionFileKind;
}

export interface VersionSummary {
  id: string;
  appId: string;
  number: number;
  createdByUserId: string | null;
  actorKind: AuditActorKind;
  reasoning: string | null;
  compileStatus: CompileStatus;
  compileErrors: unknown;
  createdAt: Date;
  /** True when `apps.published_version_id` points at this version. */
  published: boolean;
  /** True for the newest version that compiled — the one the preview host serves. */
  preview: boolean;
  /** True while a member keeps the version (the retention and a clean-up leave it alone). */
  kept: boolean;
  /** When it was kept; null when it is not. */
  keptAt: Date | null;
  /** Who kept it; null when it is not kept or their account is gone. */
  keptByUserId: string | null;
}

/** One page of an app's history, newest first. */
export interface VersionPage {
  versions: VersionSummary[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  nextBefore: number | null;
}

export interface VersionDetail extends VersionSummary {
  files: VersionFile[];
}
