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
}

export interface VersionDetail extends VersionSummary {
  files: VersionFile[];
}
