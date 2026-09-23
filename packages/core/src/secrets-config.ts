/**
 * Fail-closed start (PHY-76 #6): refuse to boot with a known placeholder or,
 * in production, a missing/weak secret. Copying `.env.example` verbatim must
 * never produce a running instance that encrypts upstream secrets with a
 * published key.
 *
 * Only variable NAMES are ever reported — never values.
 */

/** Secrets checked for placeholder values whenever they are set. */
export const SECRET_ENV_VARS = [
  'DROBEK_MASTER_KEY',
  'SMTP_PASS',
  'GOOGLE_CLIENT_SECRET',
  'TLS_ASK_TOKEN',
] as const;

/** Secrets a production instance cannot run without. */
export const REQUIRED_PRODUCTION_SECRETS = ['DROBEK_MASTER_KEY'] as const;

const PLACEHOLDER = /^(change[-_ ]?me|replace[-_ ]?me|placeholder|xxx+)(\b|$)/i;

export interface SecretProblem {
  name: string;
  reason: 'placeholder' | 'missing' | 'weak';
}

export function findSecretProblems(
  env: NodeJS.ProcessEnv = process.env
): SecretProblem[] {
  const production = env.NODE_ENV === 'production';
  const problems: SecretProblem[] = [];

  for (const name of SECRET_ENV_VARS) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (PLACEHOLDER.test(value)) {
      problems.push({ name, reason: 'placeholder' });
    } else if (production && /^0+$/.test(value)) {
      // The dev compose default KEK is 64 zeros — fine locally, fatal in prod.
      problems.push({ name, reason: 'weak' });
    }
  }

  if (production) {
    for (const name of REQUIRED_PRODUCTION_SECRETS) {
      if (!env[name]?.trim()) problems.push({ name, reason: 'missing' });
    }
  }
  return problems;
}

/** Human-readable startup error, or null when the config is acceptable. */
export function secretsConfigError(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const problems = findSecretProblems(env);
  if (problems.length === 0) return null;
  const lines = problems.map((p) => {
    if (p.reason === 'missing') return `  - ${p.name} is not set (required in production)`;
    if (p.reason === 'weak') return `  - ${p.name} is an all-zero dev key`;
    return `  - ${p.name} still has its placeholder value from .env.example`;
  });
  return [
    'drobek refuses to start: insecure secret configuration.',
    ...lines,
    'Generate real values with `openssl rand -hex 32` and set them in .env.',
  ].join('\n');
}
